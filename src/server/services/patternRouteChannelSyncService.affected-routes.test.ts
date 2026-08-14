import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type SyncServiceModule = typeof import('./patternRouteChannelSyncService.js');

describe('syncPatternRouteChannelsAfterAffectedRouteChanges', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let syncPatternRouteChannelsAfterAffectedRouteChanges: SyncServiceModule['syncPatternRouteChannelsAfterAffectedRouteChanges'];
  let reconcilePatternRouteChannels: SyncServiceModule['reconcilePatternRouteChannels'];
  let dataDir = '';
  let seedId = 0;

  const nextId = () => {
    seedId += 1;
    return seedId;
  };

  const seedAccountWithToken = async (modelName: string) => {
    const id = nextId();
    const site = await db.insert(schema.sites).values({
      name: `site-${id}`,
      url: `https://example.com/${id}`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${id}`,
      accessToken: `access-${id}`,
      status: 'active',
    }).returning().get();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `token-${id}`,
      token: `sk-token-${id}`,
      enabled: true,
      isDefault: true,
    }).returning().get();
    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName,
      available: true,
    }).run();
    return { site, account, token };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-pattern-route-sync-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const syncService = await import('./patternRouteChannelSyncService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    syncPatternRouteChannelsAfterAffectedRouteChanges = syncService.syncPatternRouteChannelsAfterAffectedRouteChanges;
    reconcilePatternRouteChannels = syncService.reconcilePatternRouteChannels;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.oauthRouteUnitMembers).run();
    await db.delete(schema.oauthRouteUnits).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    seedId = 0;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('reconciles only enabled pattern routes matching affected exact models', async () => {
    const source = await seedAccountWithToken('gpt-5-mini');
    const unrelatedSource = await seedAccountWithToken('claude-sonnet-4-5');
    const exactRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-mini',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: exactRoute.id,
      accountId: source.account.id,
      tokenId: source.token.id,
      sourceModel: 'gpt-5-mini',
      enabled: true,
      manualOverride: true,
    }).run();
    const matchingPattern = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-*',
      enabled: true,
    }).returning().get();
    const unrelatedPattern = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-*',
      enabled: true,
    }).returning().get();
    const unrelatedChannel = await db.insert(schema.routeChannels).values({
      routeId: unrelatedPattern.id,
      accountId: unrelatedSource.account.id,
      tokenId: unrelatedSource.token.id,
      sourceModel: 'claude-sonnet-4-5',
      enabled: true,
      manualOverride: false,
      successCount: 9,
    }).returning().get();

    const result = await syncPatternRouteChannelsAfterAffectedRouteChanges({
      affectedRouteIds: [exactRoute.id],
      previousRoutes: [{
        id: exactRoute.id,
        modelPattern: exactRoute.modelPattern,
        routeMode: exactRoute.routeMode,
        enabled: !!exactRoute.enabled,
      }],
    });

    expect(result).toEqual({
      rebuiltRoutes: 1,
      createdChannels: 1,
      removedChannels: 0,
    });
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, matchingPattern.id)).all()).toContainEqual(expect.objectContaining({
        accountId: source.account.id,
        tokenId: source.token.id,
        sourceModel: 'gpt-5-mini',
        manualOverride: false,
      }));
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, unrelatedChannel.id)).get()).toMatchObject({
        id: unrelatedChannel.id,
        successCount: 9,
      });
  });

  it('uses the complete previous snapshot to remove a deleted exact source without resurrecting availability', async () => {
    const source = await seedAccountWithToken('gpt-5-removed');
    const manualSource = await seedAccountWithToken('manual-special');
    const exactRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-removed',
      enabled: true,
    }).returning().get();
    const patternRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^gpt-5.*$',
      enabled: true,
    }).returning().get();
    const staleChannel = await db.insert(schema.routeChannels).values({
      routeId: patternRoute.id,
      accountId: source.account.id,
      tokenId: source.token.id,
      sourceModel: 'gpt-5-removed',
      enabled: true,
      manualOverride: false,
    }).returning().get();
    const manualChannel = await db.insert(schema.routeChannels).values({
      routeId: patternRoute.id,
      accountId: manualSource.account.id,
      tokenId: manualSource.token.id,
      sourceModel: 'manual-special',
      enabled: true,
      manualOverride: true,
    }).returning().get();

    await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, exactRoute.id)).run();
    const result = await syncPatternRouteChannelsAfterAffectedRouteChanges({
      affectedRouteIds: [exactRoute.id],
      previousRoutes: [{
        id: exactRoute.id,
        modelPattern: exactRoute.modelPattern,
        routeMode: exactRoute.routeMode,
        enabled: !!exactRoute.enabled,
      }],
    });

    expect(result).toEqual({
      rebuiltRoutes: 1,
      createdChannels: 0,
      removedChannels: 1,
    });
    const channels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, patternRoute.id)).all();
    expect(channels.some((channel) => channel.id === staleChannel.id)).toBe(false);
    expect(channels.map((channel) => channel.id)).toEqual([manualChannel.id]);
  });

  it('ignores a removed exact route that was already disabled before the mutation', async () => {
    const exactRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-disabled',
      enabled: false,
    }).returning().get();
    await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-*',
      enabled: true,
    }).run();

    await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, exactRoute.id)).run();
    const result = await syncPatternRouteChannelsAfterAffectedRouteChanges({
      affectedRouteIds: [exactRoute.id],
      previousRoutes: [{
        id: exactRoute.id,
        modelPattern: exactRoute.modelPattern,
        routeMode: exactRoute.routeMode,
        enabled: false,
      }],
    });

    expect(result).toEqual({
      rebuiltRoutes: 0,
      createdChannels: 0,
      removedChannels: 0,
    });
  });

  it('retains automatic channel identity and telemetry while updating OAuth routing fields', async () => {
    const sourceA = await seedAccountWithToken('gpt-5-oauth');
    const sourceB = await seedAccountWithToken('gpt-5-oauth');
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: sourceA.site.id,
      provider: 'codex',
      name: 'Codex Route Unit',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([
      { unitId: routeUnit.id, accountId: sourceA.account.id, sortOrder: 0 },
      { unitId: routeUnit.id, accountId: sourceB.account.id, sortOrder: 1 },
    ]).run();
    const exactRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-oauth',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: exactRoute.id,
      accountId: sourceB.account.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      sourceModel: 'gpt-5-oauth',
      priority: 7,
      weight: 3,
      enabled: false,
      manualOverride: false,
    }).run();
    const patternRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-*',
      enabled: true,
    }).returning().get();
    const existing = await db.insert(schema.routeChannels).values({
      routeId: patternRoute.id,
      accountId: sourceA.account.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      sourceModel: 'GPT-5-OAUTH',
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
      successCount: 11,
      failCount: 2,
      totalLatencyMs: 345,
      totalCost: 6.25,
    }).returning().get();

    const result = await syncPatternRouteChannelsAfterAffectedRouteChanges({
      affectedRouteIds: [exactRoute.id],
      previousRoutes: [{
        id: exactRoute.id,
        modelPattern: exactRoute.modelPattern,
        routeMode: exactRoute.routeMode,
        enabled: !!exactRoute.enabled,
      }],
    });

    expect(result).toEqual({
      rebuiltRoutes: 1,
      createdChannels: 0,
      removedChannels: 0,
    });
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, existing.id)).get()).toMatchObject({
        id: existing.id,
        accountId: sourceB.account.id,
        oauthRouteUnitId: routeUnit.id,
        sourceModel: 'GPT-5-OAUTH',
        priority: 7,
        weight: 3,
        enabled: false,
        manualOverride: false,
        successCount: 11,
        failCount: 2,
        totalLatencyMs: 345,
        totalCost: 6.25,
      });
  });

  it('serializes concurrent reconciliation so one automatic identity is inserted', async () => {
    const source = await seedAccountWithToken('gpt-5-concurrent');
    const patternRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-*',
      enabled: true,
    }).returning().get();
    const input = {
      patternRouteIds: [patternRoute.id],
      desiredCandidates: [{
        accountId: source.account.id,
        tokenId: source.token.id,
        oauthRouteUnitId: null,
        sourceModel: 'gpt-5-concurrent',
        matchModel: 'gpt-5-concurrent',
        priority: 4,
        weight: 6,
        enabled: true,
      }],
    };

    await Promise.all([
      reconcilePatternRouteChannels(input),
      reconcilePatternRouteChannels(input),
    ]);

    const channels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, patternRoute.id)).all();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      accountId: source.account.id,
      tokenId: source.token.id,
      sourceModel: 'gpt-5-concurrent',
    });
  });

  it('rolls back stale deletions when a replacement insert fails', async () => {
    const source = await seedAccountWithToken('gpt-5-stale');
    const patternRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-*',
      enabled: true,
    }).returning().get();
    const staleChannel = await db.insert(schema.routeChannels).values({
      routeId: patternRoute.id,
      accountId: source.account.id,
      tokenId: source.token.id,
      sourceModel: 'gpt-5-stale',
      priority: 8,
      weight: 2,
      enabled: false,
      manualOverride: false,
      successCount: 5,
    }).returning().get();

    await expect(reconcilePatternRouteChannels({
      patternRouteIds: [patternRoute.id],
      desiredCandidates: [{
        accountId: 999_999,
        tokenId: null,
        oauthRouteUnitId: null,
        sourceModel: 'gpt-5-replacement',
        matchModel: 'gpt-5-replacement',
        priority: 0,
        weight: 10,
        enabled: true,
      }],
    })).rejects.toThrow();

    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, staleChannel.id)).get()).toMatchObject({
        id: staleChannel.id,
        priority: 8,
        weight: 2,
        enabled: false,
        successCount: 5,
      });
  });

  it('lets a same-identity manual account channel supersede its automatic duplicate unchanged', async () => {
    const source = await seedAccountWithToken('gpt-5-manual-account');
    const patternRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-*',
      enabled: true,
    }).returning().get();
    const manualChannel = await db.insert(schema.routeChannels).values({
      routeId: patternRoute.id,
      accountId: source.account.id,
      tokenId: source.token.id,
      sourceModel: 'gpt-5-manual-account',
      priority: 9,
      weight: 1,
      enabled: false,
      manualOverride: true,
      successCount: 17,
      failCount: 4,
      totalLatencyMs: 876,
      totalCost: 3.25,
    }).returning().get();
    const automaticChannel = await db.insert(schema.routeChannels).values({
      routeId: patternRoute.id,
      accountId: source.account.id,
      tokenId: source.token.id,
      sourceModel: 'GPT-5-MANUAL-ACCOUNT',
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    await reconcilePatternRouteChannels({
      patternRouteIds: [patternRoute.id],
      desiredCandidates: [{
        accountId: source.account.id,
        tokenId: source.token.id,
        oauthRouteUnitId: null,
        sourceModel: 'gpt-5-manual-account',
        matchModel: 'gpt-5-manual-account',
        priority: 3,
        weight: 7,
        enabled: true,
      }],
    });

    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, automaticChannel.id)).get()).toBeUndefined();
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, manualChannel.id)).get()).toMatchObject({
        id: manualChannel.id,
        accountId: source.account.id,
        tokenId: source.token.id,
        sourceModel: 'gpt-5-manual-account',
        priority: 9,
        weight: 1,
        enabled: false,
        manualOverride: true,
        successCount: 17,
        failCount: 4,
        totalLatencyMs: 876,
        totalCost: 3.25,
      });
  });

  it('lets a same-identity manual OAuth route-unit channel supersede its automatic duplicate unchanged', async () => {
    const sourceA = await seedAccountWithToken('gpt-5-manual-oauth');
    const sourceB = await seedAccountWithToken('gpt-5-manual-oauth');
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: sourceA.site.id,
      provider: 'codex',
      name: 'Manual OAuth Unit',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([
      { unitId: routeUnit.id, accountId: sourceA.account.id, sortOrder: 0 },
      { unitId: routeUnit.id, accountId: sourceB.account.id, sortOrder: 1 },
    ]).run();
    const patternRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-*',
      enabled: true,
    }).returning().get();
    const manualChannel = await db.insert(schema.routeChannels).values({
      routeId: patternRoute.id,
      accountId: sourceA.account.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      sourceModel: 'gpt-5-manual-oauth',
      priority: 8,
      weight: 2,
      enabled: false,
      manualOverride: true,
      successCount: 21,
      failCount: 6,
      totalLatencyMs: 654,
      totalCost: 9.75,
    }).returning().get();
    const automaticChannel = await db.insert(schema.routeChannels).values({
      routeId: patternRoute.id,
      accountId: sourceB.account.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      sourceModel: 'GPT-5-MANUAL-OAUTH',
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    await reconcilePatternRouteChannels({
      patternRouteIds: [patternRoute.id],
      desiredCandidates: [{
        accountId: sourceB.account.id,
        tokenId: null,
        oauthRouteUnitId: routeUnit.id,
        sourceModel: 'gpt-5-manual-oauth',
        matchModel: 'gpt-5-manual-oauth',
        priority: 4,
        weight: 6,
        enabled: true,
      }],
    });

    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, automaticChannel.id)).get()).toBeUndefined();
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, manualChannel.id)).get()).toMatchObject({
        id: manualChannel.id,
        accountId: sourceA.account.id,
        tokenId: null,
        oauthRouteUnitId: routeUnit.id,
        sourceModel: 'gpt-5-manual-oauth',
        priority: 8,
        weight: 2,
        enabled: false,
        manualOverride: true,
        successCount: 21,
        failCount: 6,
        totalLatencyMs: 654,
        totalCost: 9.75,
      });
  });
});
