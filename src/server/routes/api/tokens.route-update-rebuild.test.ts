import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray, sql } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('PUT /api/routes/:id route rebuild', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let resetTokenRouteReadLimitersForTests: (options?: { summaryPoints?: number; listPoints?: number }) => void;
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
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-route-update-rebuild-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tokens.js');
    db = dbModule.db;
    schema = dbModule.schema;
    resetTokenRouteReadLimitersForTests = routesModule.resetTokenRouteReadLimitersForTests;

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    resetTokenRouteReadLimitersForTests();
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

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('rebuilds only automatic channels when modelPattern changes', async () => {
    const oldCandidate = await seedAccountWithToken('claude-opus-4-5');
    const newCandidate = await seedAccountWithToken('gemini-2.0-flash');
    const manualCandidate = await seedAccountWithToken('manual-special');

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^claude-.*$',
      displayName: 'old-group',
      enabled: true,
    }).returning().get();

    const autoChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: oldCandidate.account.id,
      tokenId: oldCandidate.token.id,
      sourceModel: 'claude-opus-4-5',
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const manualChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: manualCandidate.account.id,
      tokenId: manualCandidate.token.id,
      sourceModel: 'manual-special',
      priority: 7,
      weight: 3,
      enabled: true,
      manualOverride: true,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/routes/${route.id}`,
      payload: {
        modelPattern: 're:^gemini-.*$',
        displayName: 'new-group',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: route.id,
      modelPattern: 're:^gemini-.*$',
      displayName: 'new-group',
    });

    const routeChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, route.id))
      .all();

    expect(routeChannels.some((channel) => channel.id === manualChannel.id)).toBe(true);
    expect(routeChannels.some((channel) => channel.id === autoChannel.id)).toBe(false);

    const rebuiltAuto = routeChannels.find((channel) =>
      channel.accountId === newCandidate.account.id
      && channel.tokenId === newCandidate.token.id
      && channel.sourceModel === 'gemini-2.0-flash',
    );

    expect(rebuiltAuto).toBeDefined();
    expect(rebuiltAuto?.manualOverride).toBe(false);
    expect(rebuiltAuto?.priority).toBe(0);
    expect(rebuiltAuto?.weight).toBe(10);
  });

  it('adds a manually added exact-route channel to matching regex routes', async () => {
    const candidate = await seedAccountWithToken('claude-opus-4-5');
    const exactRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-5',
      enabled: true,
    }).returning().get();
    const regexRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^claude-.*$',
      enabled: true,
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${exactRoute.id}/channels`,
      payload: {
        accountId: candidate.account.id,
        tokenId: candidate.token.id,
      },
    });

    expect(response.statusCode).toBe(200);

    const regexChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, regexRoute.id))
      .all();
    expect(regexChannels).toContainEqual(expect.objectContaining({
      routeId: regexRoute.id,
      accountId: candidate.account.id,
      tokenId: candidate.token.id,
      sourceModel: 'claude-opus-4-5',
      manualOverride: false,
    }));
  });

  it.each([
    ['wildcard', 'gpt-5-*'],
    ['regex', 're:^gpt-5-.*$'],
  ])('preserves a single manually added %s-route channel', async (_label, modelPattern) => {
    const candidate = await seedAccountWithToken('gpt-5-manual');
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern,
      enabled: true,
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels`,
      payload: {
        accountId: candidate.account.id,
        tokenId: candidate.token.id,
        sourceModel: 'gpt-5-manual',
        priority: 6,
        weight: 4,
      },
    });

    expect(response.statusCode).toBe(200);
    const created = response.json() as { id: number };
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, created.id)).get()).toMatchObject({
      id: created.id,
      routeId: route.id,
      accountId: candidate.account.id,
      tokenId: candidate.token.id,
      sourceModel: 'gpt-5-manual',
      priority: 6,
      weight: 4,
      manualOverride: true,
    });
  });

  it('populates an enabled empty exact route from direct OAuth route-unit candidates', async () => {
    const id = nextId();
    const site = await db.insert(schema.sites).values({
      name: `oauth-site-${id}`,
      url: `https://oauth.example.com/${id}`,
      platform: 'openai',
      status: 'active',
    }).returning().get();
    const accounts: Array<typeof schema.accounts.$inferSelect> = [];
    for (const suffix of ['a', 'b']) {
      const account = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: `oauth-${suffix}-${id}`,
        accessToken: `oauth-access-${suffix}-${id}`,
        oauthProvider: 'codex',
        status: 'active',
      }).returning().get();
      await db.insert(schema.modelAvailability).values({
        accountId: account.id,
        modelName: 'gpt-5-oauth-empty',
        available: true,
      }).run();
      accounts.push(account);
    }
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'OAuth Empty Route Unit',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([
      { unitId: routeUnit.id, accountId: accounts[0]!.id, sortOrder: 0 },
      { unitId: routeUnit.id, accountId: accounts[1]!.id, sortOrder: 1 },
    ]).run();
    const exactRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-oauth-empty',
      enabled: false,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/routes/${exactRoute.id}`,
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(200);
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, exactRoute.id)).all()).toEqual([
      expect.objectContaining({
        accountId: accounts[0]!.id,
        tokenId: null,
        oauthRouteUnitId: routeUnit.id,
        sourceModel: 'gpt-5-oauth-empty',
        manualOverride: false,
      }),
    ]);
  });

  it('rolls back a channel add when affected-pattern reconciliation fails', async () => {
    const candidate = await seedAccountWithToken('gpt-5-atomic-add');
    const exactRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-atomic-add',
      enabled: true,
    }).returning().get();
    const patternRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-*',
      enabled: true,
    }).returning().get();

    await db.run(sql.raw(`
      CREATE TRIGGER fail_atomic_pattern_insert
      BEFORE INSERT ON route_channels
      WHEN NEW.route_id = ${patternRoute.id} AND COALESCE(NEW.manual_override, 0) = 0
      BEGIN
        SELECT RAISE(ABORT, 'forced reconciliation failure');
      END
    `));
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/routes/${exactRoute.id}/channels`,
        payload: {
          accountId: candidate.account.id,
          tokenId: candidate.token.id,
        },
      });

      expect(response.statusCode).toBe(500);
      expect(await db.select().from(schema.routeChannels)
        .where(inArray(schema.routeChannels.routeId, [exactRoute.id, patternRoute.id])).all()).toEqual([]);
    } finally {
      await db.run(sql.raw('DROP TRIGGER IF EXISTS fail_atomic_pattern_insert'));
    }
  });

  it('rolls back a route delete when stale pattern-channel removal fails', async () => {
    const candidate = await seedAccountWithToken('gpt-5-atomic-delete');
    const exactRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-atomic-delete',
      enabled: true,
    }).returning().get();
    const exactChannel = await db.insert(schema.routeChannels).values({
      routeId: exactRoute.id,
      accountId: candidate.account.id,
      tokenId: candidate.token.id,
      sourceModel: 'gpt-5-atomic-delete',
      enabled: true,
      manualOverride: true,
    }).returning().get();
    const patternRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-*',
      enabled: true,
    }).returning().get();
    const patternChannel = await db.insert(schema.routeChannels).values({
      routeId: patternRoute.id,
      accountId: candidate.account.id,
      tokenId: candidate.token.id,
      sourceModel: 'gpt-5-atomic-delete',
      enabled: true,
      manualOverride: false,
    }).returning().get();

    await db.run(sql.raw(`
      CREATE TRIGGER fail_atomic_pattern_delete
      BEFORE DELETE ON route_channels
      WHEN OLD.id = ${patternChannel.id}
      BEGIN
        SELECT RAISE(ABORT, 'forced reconciliation failure');
      END
    `));
    try {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/routes/${exactRoute.id}`,
      });

      expect(response.statusCode).toBe(500);
      expect(await db.select().from(schema.tokenRoutes)
        .where(eq(schema.tokenRoutes.id, exactRoute.id)).get()).toMatchObject({ id: exactRoute.id });
      expect(await db.select().from(schema.routeChannels)
        .where(eq(schema.routeChannels.id, exactChannel.id)).get()).toMatchObject({ id: exactChannel.id });
      expect(await db.select().from(schema.routeChannels)
        .where(eq(schema.routeChannels.id, patternChannel.id)).get()).toMatchObject({ id: patternChannel.id });
    } finally {
      await db.run(sql.raw('DROP TRIGGER IF EXISTS fail_atomic_pattern_delete'));
    }
  });

  it('rate limits repeated route overview reads', async () => {
    resetTokenRouteReadLimitersForTests({
      summaryPoints: 1,
      listPoints: 1,
    });

    const firstSummary = await app.inject({
      method: 'GET',
      url: '/api/routes/summary',
    });
    const secondSummary = await app.inject({
      method: 'GET',
      url: '/api/routes/summary',
    });
    const firstRoutes = await app.inject({
      method: 'GET',
      url: '/api/routes',
    });
    const secondRoutes = await app.inject({
      method: 'GET',
      url: '/api/routes',
    });

    expect(firstSummary.statusCode).toBe(200);
    expect(secondSummary.statusCode).toBe(429);
    expect(firstRoutes.statusCode).toBe(200);
    expect(secondRoutes.statusCode).toBe(429);
  });

  it('creates explicit-group routes with sourceRouteIds and aggregates source channels', async () => {
    const sourceA = await seedAccountWithToken('claude-opus-4-5');
    const sourceB = await seedAccountWithToken('claude-sonnet-4-5');

    const exactRouteA = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-5',
      enabled: true,
    }).returning().get();
    const exactRouteB = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-sonnet-4-5',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values([
      {
        routeId: exactRouteA.id,
        accountId: sourceA.account.id,
        tokenId: sourceA.token.id,
        sourceModel: 'claude-opus-4-5',
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      },
      {
        routeId: exactRouteB.id,
        accountId: sourceB.account.id,
        tokenId: sourceB.token.id,
        sourceModel: 'claude-sonnet-4-5',
        priority: 1,
        weight: 8,
        enabled: true,
        manualOverride: false,
      },
    ]).run();

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: 'claude-opus-4-6',
        sourceRouteIds: [exactRouteA.id, exactRouteB.id],
        routingStrategy: 'weighted',
      },
    });

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json()).toMatchObject({
      displayName: 'claude-opus-4-6',
      routeMode: 'explicit_group',
      sourceRouteIds: [exactRouteA.id, exactRouteB.id],
    });

    const createdRouteId = (createResponse.json() as { id: number }).id;

    const storedChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, createdRouteId))
      .all();
    expect(storedChannels).toHaveLength(0);

    const summaryResponse = await app.inject({
      method: 'GET',
      url: '/api/routes/summary',
    });
    expect(summaryResponse.statusCode).toBe(200);
    expect(summaryResponse.json()).toContainEqual(expect.objectContaining({
      id: createdRouteId,
      routeMode: 'explicit_group',
      sourceRouteIds: [exactRouteA.id, exactRouteB.id],
      channelCount: 2,
      enabledChannelCount: 2,
      siteNames: expect.arrayContaining([sourceA.site.name, sourceB.site.name]),
    }));

    const channelsResponse = await app.inject({
      method: 'GET',
      url: `/api/routes/${createdRouteId}/channels`,
    });
    expect(channelsResponse.statusCode).toBe(200);
    expect(channelsResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        routeId: exactRouteA.id,
        accountId: sourceA.account.id,
        sourceModel: 'claude-opus-4-5',
      }),
      expect.objectContaining({
        routeId: exactRouteB.id,
        accountId: sourceB.account.id,
        sourceModel: 'claude-sonnet-4-5',
      }),
    ]));
  });

  it('syncs explicit-group routing strategy to unique source routes', async () => {
    await seedAccountWithToken('claude-opus-4-5');
    await seedAccountWithToken('claude-sonnet-4-5');

    const exactRouteA = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-5',
      enabled: true,
      routingStrategy: 'weighted',
    }).returning().get();
    const exactRouteB = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-sonnet-4-5',
      enabled: true,
      routingStrategy: 'weighted',
    }).returning().get();

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: 'claude-opus-4-6',
        sourceRouteIds: [exactRouteA.id, exactRouteB.id],
        routingStrategy: 'stable_first',
      },
    });

    expect(createResponse.statusCode).toBe(200);

    const refreshedRouteA = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.id, exactRouteA.id))
      .get();
    const refreshedRouteB = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.id, exactRouteB.id))
      .get();

    expect(refreshedRouteA?.routingStrategy).toBe('stable_first');
    expect(refreshedRouteB?.routingStrategy).toBe('stable_first');

    const groupRouteId = (createResponse.json() as { id: number }).id;
    const updateResponse = await app.inject({
      method: 'PUT',
      url: `/api/routes/${groupRouteId}`,
      payload: {
        routingStrategy: 'round_robin',
      },
    });

    expect(updateResponse.statusCode).toBe(200);

    const updatedRouteA = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.id, exactRouteA.id))
      .get();
    const updatedRouteB = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.id, exactRouteB.id))
      .get();

    expect(updatedRouteA?.routingStrategy).toBe('round_robin');
    expect(updatedRouteB?.routingStrategy).toBe('round_robin');
  });

  it('does not overwrite source routes shared by another explicit-group', async () => {
    await seedAccountWithToken('claude-opus-4-5');

    const sharedSourceRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-5',
      enabled: true,
      routingStrategy: 'weighted',
    }).returning().get();

    const firstGroupResponse = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: 'claude-opus-4-6',
        sourceRouteIds: [sharedSourceRoute.id],
        routingStrategy: 'stable_first',
      },
    });
    expect(firstGroupResponse.statusCode).toBe(200);

    await db.update(schema.tokenRoutes).set({
      routingStrategy: 'weighted',
    }).where(eq(schema.tokenRoutes.id, sharedSourceRoute.id)).run();

    const secondGroupResponse = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: 'claude-opus-4-6-alt',
        sourceRouteIds: [sharedSourceRoute.id],
        routingStrategy: 'round_robin',
      },
    });
    expect(secondGroupResponse.statusCode).toBe(200);

    const refreshedSharedRoute = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.id, sharedSourceRoute.id))
      .get();

    expect(refreshedSharedRoute?.routingStrategy).toBe('weighted');
  });

  it('fills missing sourceModel from source exact routes when loading explicit-group channels', async () => {
    const sourceA = await seedAccountWithToken('deepseek-chat');
    const sourceB = await seedAccountWithToken('deepseek-reasoner');

    const exactRouteA = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'deepseek-chat',
      enabled: true,
    }).returning().get();
    const exactRouteB = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'deepseek-reasoner',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values([
      {
        routeId: exactRouteA.id,
        accountId: sourceA.account.id,
        tokenId: sourceA.token.id,
        sourceModel: null,
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      },
      {
        routeId: exactRouteB.id,
        accountId: sourceB.account.id,
        tokenId: sourceB.token.id,
        sourceModel: null,
        priority: 1,
        weight: 8,
        enabled: true,
        manualOverride: false,
      },
    ]).run();

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: 'deepseekv1',
        sourceRouteIds: [exactRouteA.id, exactRouteB.id],
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const createdRouteId = (createResponse.json() as { id: number }).id;

    const channelsResponse = await app.inject({
      method: 'GET',
      url: `/api/routes/${createdRouteId}/channels`,
    });

    expect(channelsResponse.statusCode).toBe(200);
    expect(channelsResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        routeId: exactRouteA.id,
        accountId: sourceA.account.id,
        sourceModel: 'deepseek-chat',
      }),
      expect.objectContaining({
        routeId: exactRouteB.id,
        accountId: sourceB.account.id,
        sourceModel: 'deepseek-reasoner',
      }),
    ]));
  });

  it('rejects invalid explicit-group payloads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: '',
        sourceRouteIds: [],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
    });
  });

  it('rejects non-string displayName when creating explicit-group routes', async () => {
    const sourceRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-5',
      enabled: true,
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: 123,
        sourceRouteIds: [sourceRoute.id],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Invalid displayName. Expected string or null.',
    });
  });

  it('rejects non-number sourceRouteIds when creating explicit-group routes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: 'claude-opus-4-6',
        sourceRouteIds: ['1'],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Invalid sourceRouteIds. Expected number[].',
    });
  });

  it('rejects non-boolean enabled when updating routes', async () => {
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o',
      enabled: true,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/routes/${route.id}`,
      payload: {
        enabled: 'false',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Invalid enabled. Expected boolean.',
    });
  });

  it('rejects non-number accountId when adding route channels', async () => {
    const seeded = await seedAccountWithToken('gpt-4o-mini');
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels`,
      payload: {
        accountId: String(seeded.account.id),
        tokenId: seeded.token.id,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Invalid accountId. Expected positive number.',
    });
  });

  it('rejects non-boolean enabled when updating channels', async () => {
    const seeded = await seedAccountWithToken('gpt-4o-mini');
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: seeded.account.id,
      tokenId: seeded.token.id,
      sourceModel: 'gpt-4o-mini',
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/channels/${channel.id}`,
      payload: {
        enabled: 'false',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Invalid enabled. Expected boolean.',
    });
  });

  it('rejects non-number accountId when batch-adding route channels', async () => {
    const seeded = await seedAccountWithToken('gpt-4o-mini');
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels/batch`,
      payload: {
        channels: [
          {
            accountId: String(seeded.account.id),
            tokenId: seeded.token.id,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Invalid channels[].accountId. Expected positive number.',
    });
  });

  it('uses the account default token when adding a route channel without tokenId', async () => {
    const seeded = await seedAccountWithToken('gpt-4o-mini');
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    const createdResponse = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels`,
      payload: {
        accountId: seeded.account.id,
      },
    });

    expect(createdResponse.statusCode).toBe(200);
    expect(createdResponse.json()).toMatchObject({
      accountId: seeded.account.id,
      tokenId: seeded.token.id,
      sourceModel: 'gpt-4o-mini',
    });

    const duplicateResponse = await app.inject({
      method: 'POST',
      url: `/api/routes/${route.id}/channels`,
      payload: {
        accountId: seeded.account.id,
      },
    });

    expect(duplicateResponse.statusCode).toBe(400);
    expect(duplicateResponse.json()).toMatchObject({
      success: false,
      message: '该来源模型的通道已存在',
    });
  });

  it('accepts null tokenId when updating a channel and falls back to the account default token', async () => {
    const seeded = await seedAccountWithToken('gpt-4o-mini');
    const alternateToken = await db.insert(schema.accountTokens).values({
      accountId: seeded.account.id,
      name: 'token-alt',
      token: 'sk-token-alt',
      enabled: true,
      isDefault: false,
    }).returning().get();
    await db.insert(schema.tokenModelAvailability).values({
      tokenId: alternateToken.id,
      modelName: 'gpt-4o-mini',
      available: true,
    }).run();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: seeded.account.id,
      tokenId: alternateToken.id,
      sourceModel: 'gpt-4o-mini',
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: true,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/channels/${channel.id}`,
      payload: {
        tokenId: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: channel.id,
      tokenId: seeded.token.id,
    });

    const updated = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).get();
    expect(updated?.tokenId).toBe(seeded.token.id);
  });

  it('populates a disabled exact route and matching pattern route when singly enabled', async () => {
    const source = await seedAccountWithToken('gpt-5-disabled-single');
    const exactResponse = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        modelPattern: 'gpt-5-disabled-single',
        enabled: false,
      },
    });
    expect(exactResponse.statusCode).toBe(200);
    const exactRouteId = exactResponse.json().id as number;
    const patternResponse = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        modelPattern: 'gpt-5-disabled-*',
        enabled: true,
      },
    });
    expect(patternResponse.statusCode).toBe(200);
    const patternRouteId = patternResponse.json().id as number;
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, exactRouteId)).all()).toHaveLength(0);

    const enableResponse = await app.inject({
      method: 'PUT',
      url: `/api/routes/${exactRouteId}`,
      payload: { enabled: true },
    });

    expect(enableResponse.statusCode).toBe(200);
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, exactRouteId)).all()).toContainEqual(expect.objectContaining({
        accountId: source.account.id,
        tokenId: source.token.id,
        sourceModel: 'gpt-5-disabled-single',
      }));
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, patternRouteId)).all()).toContainEqual(expect.objectContaining({
        accountId: source.account.id,
        tokenId: source.token.id,
        sourceModel: 'gpt-5-disabled-single',
      }));
  });

  it('populates disabled exact routes and matching pattern routes when batch enabled', async () => {
    const sourceA = await seedAccountWithToken('gpt-5-disabled-batch-a');
    const sourceB = await seedAccountWithToken('gpt-5-disabled-batch-b');
    const exactRouteIds: number[] = [];
    for (const modelPattern of ['gpt-5-disabled-batch-a', 'gpt-5-disabled-batch-b']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/routes',
        payload: { modelPattern, enabled: false },
      });
      expect(response.statusCode).toBe(200);
      exactRouteIds.push(response.json().id as number);
    }
    const patternResponse = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        modelPattern: 'gpt-5-disabled-batch-*',
        enabled: true,
      },
    });
    expect(patternResponse.statusCode).toBe(200);
    const patternRouteId = patternResponse.json().id as number;

    const enableResponse = await app.inject({
      method: 'POST',
      url: '/api/routes/batch',
      payload: { ids: exactRouteIds, action: 'enable' },
    });

    expect(enableResponse.statusCode).toBe(200);
    const exactChannels = await db.select().from(schema.routeChannels)
      .where(inArray(schema.routeChannels.routeId, exactRouteIds)).all();
    expect(exactChannels).toHaveLength(2);
    const patternChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, patternRouteId)).all();
    expect(patternChannels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: sourceA.account.id,
        tokenId: sourceA.token.id,
        sourceModel: 'gpt-5-disabled-batch-a',
      }),
      expect.objectContaining({
        accountId: sourceB.account.id,
        tokenId: sourceB.token.id,
        sourceModel: 'gpt-5-disabled-batch-b',
      }),
    ]));
  });

  it('updates derived OAuth pattern channels in place after exact channel changes', async () => {
    const sourceA = await seedAccountWithToken('gpt-5-route-unit');
    const sourceB = await seedAccountWithToken('gpt-5-route-unit');
    const manualSource = await seedAccountWithToken('manual-special');
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
      modelPattern: 'gpt-5-route-unit',
      enabled: true,
    }).returning().get();
    const exactChannel = await db.insert(schema.routeChannels).values({
      routeId: exactRoute.id,
      accountId: sourceA.account.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      sourceModel: 'gpt-5-route-unit',
      priority: 2,
      weight: 8,
      enabled: true,
      manualOverride: false,
    }).returning().get();
    const patternRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^gpt-5-route.*$',
      enabled: true,
    }).returning().get();
    const derivedChannel = await db.insert(schema.routeChannels).values({
      routeId: patternRoute.id,
      accountId: sourceA.account.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      sourceModel: 'gpt-5-route-unit',
      priority: 2,
      weight: 8,
      enabled: true,
      manualOverride: false,
      successCount: 12,
      failCount: 3,
      totalLatencyMs: 456,
      totalCost: 7.5,
      lastUsedAt: '2026-08-14T10:00:00.000Z',
    }).returning().get();
    const manualPatternChannel = await db.insert(schema.routeChannels).values({
      routeId: patternRoute.id,
      accountId: manualSource.account.id,
      tokenId: manualSource.token.id,
      sourceModel: 'manual-special',
      priority: 9,
      weight: 1,
      enabled: true,
      manualOverride: true,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/channels/${exactChannel.id}`,
      payload: {
        priority: 7,
        weight: 4,
        enabled: false,
      },
    });

    expect(response.statusCode).toBe(200);
    const channels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, patternRoute.id))
      .all();
    expect(channels).toHaveLength(2);
    expect(channels).toContainEqual(expect.objectContaining({
      id: derivedChannel.id,
      oauthRouteUnitId: routeUnit.id,
      priority: 7,
      weight: 4,
      enabled: false,
      manualOverride: false,
      successCount: 12,
      failCount: 3,
      totalLatencyMs: 456,
      totalCost: 7.5,
      lastUsedAt: '2026-08-14T10:00:00.000Z',
    }));
    expect(channels.some((channel) => channel.id === manualPatternChannel.id)).toBe(true);
  });

  it('syncs batch channel additions and priority updates into matching pattern routes', async () => {
    const sourceA = await seedAccountWithToken('gpt-5-batch');
    const sourceB = await seedAccountWithToken('gpt-5-batch');
    const exactRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-batch',
      enabled: true,
    }).returning().get();
    const patternRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-*',
      enabled: true,
    }).returning().get();

    const addResponse = await app.inject({
      method: 'POST',
      url: `/api/routes/${exactRoute.id}/channels/batch`,
      payload: {
        channels: [
          { accountId: sourceA.account.id, tokenId: sourceA.token.id },
          { accountId: sourceB.account.id, tokenId: sourceB.token.id },
        ],
      },
    });
    expect(addResponse.statusCode).toBe(200);
    expect(addResponse.json()).toMatchObject({ created: 2 });

    const exactChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, exactRoute.id))
      .all();
    const priorityResponse = await app.inject({
      method: 'PUT',
      url: '/api/channels/batch',
      payload: {
        updates: exactChannels.map((channel, index) => ({
          id: channel.id,
          priority: index + 5,
        })),
      },
    });
    expect(priorityResponse.statusCode).toBe(200);

    const patternChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, patternRoute.id))
      .all();
    expect(patternChannels).toHaveLength(2);
    expect(patternChannels.map((channel) => channel.priority).sort()).toEqual([5, 6]);
    expect(patternChannels.every((channel) => channel.manualOverride === false)).toBe(true);
  });

  it('replaces only the stale automatic identity after exact channel token and source-model changes', async () => {
    const source = await seedAccountWithToken('gpt-5-mini');
    const alternateToken = await db.insert(schema.accountTokens).values({
      accountId: source.account.id,
      name: 'token-alt',
      token: 'sk-token-alt',
      enabled: true,
      isDefault: false,
    }).returning().get();
    await db.insert(schema.tokenModelAvailability).values({
      tokenId: alternateToken.id,
      modelName: 'gpt-5-mini',
      available: true,
    }).run();
    const manualSource = await seedAccountWithToken('manual-special');
    const exactRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-mini',
      enabled: true,
    }).returning().get();
    const exactChannel = await db.insert(schema.routeChannels).values({
      routeId: exactRoute.id,
      accountId: source.account.id,
      tokenId: source.token.id,
      sourceModel: 'gpt-5-mini',
      enabled: true,
      manualOverride: true,
    }).returning().get();
    const patternRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^gpt-5.*$',
      enabled: true,
    }).returning().get();
    const staleDerived = await db.insert(schema.routeChannels).values({
      routeId: patternRoute.id,
      accountId: source.account.id,
      tokenId: source.token.id,
      sourceModel: 'gpt-5-mini',
      enabled: true,
      manualOverride: false,
    }).returning().get();
    const manualPatternChannel = await db.insert(schema.routeChannels).values({
      routeId: patternRoute.id,
      accountId: manualSource.account.id,
      tokenId: manualSource.token.id,
      sourceModel: 'manual-special',
      enabled: true,
      manualOverride: true,
    }).returning().get();

    const updateResponse = await app.inject({
      method: 'PUT',
      url: `/api/channels/${exactChannel.id}`,
      payload: {
        tokenId: alternateToken.id,
        sourceModel: 'gpt-5-mini-alias',
      },
    });
    expect(updateResponse.statusCode).toBe(200);

    let patternChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, patternRoute.id))
      .all();
    expect(patternChannels.some((channel) => channel.id === staleDerived.id)).toBe(false);
    expect(patternChannels).toContainEqual(expect.objectContaining({
      accountId: source.account.id,
      tokenId: alternateToken.id,
      sourceModel: 'gpt-5-mini-alias',
      manualOverride: false,
    }));
    expect(patternChannels.some((channel) => channel.id === manualPatternChannel.id)).toBe(true);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/channels/${exactChannel.id}`,
    });
    expect(deleteResponse.statusCode).toBe(200);

    patternChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, patternRoute.id))
      .all();
    expect(patternChannels.map((channel) => channel.id)).toEqual([manualPatternChannel.id]);
  });

  it('reconciles matching pattern routes after exact route rename, disable, enable, and delete', async () => {
    const source = await seedAccountWithToken('gpt-5-old');
    await db.insert(schema.tokenModelAvailability).values({
      tokenId: source.token.id,
      modelName: 'claude-5-new',
      available: true,
    }).run();
    const exactRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-old',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: exactRoute.id,
      accountId: source.account.id,
      tokenId: source.token.id,
      sourceModel: 'gpt-5-old',
      enabled: true,
      manualOverride: false,
    }).run();
    const oldPattern = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-*',
      enabled: true,
    }).returning().get();
    const newPattern = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-*',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: oldPattern.id,
      accountId: source.account.id,
      tokenId: source.token.id,
      sourceModel: 'gpt-5-old',
      enabled: true,
      manualOverride: false,
    }).run();

    const disableResponse = await app.inject({
      method: 'PUT',
      url: `/api/routes/${exactRoute.id}`,
      payload: { enabled: false },
    });
    expect(disableResponse.statusCode).toBe(200);
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, oldPattern.id)).all()).toHaveLength(0);

    const enableResponse = await app.inject({
      method: 'PUT',
      url: `/api/routes/${exactRoute.id}`,
      payload: { enabled: true },
    });
    expect(enableResponse.statusCode).toBe(200);
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, oldPattern.id)).all()).toHaveLength(1);

    const renameResponse = await app.inject({
      method: 'PUT',
      url: `/api/routes/${exactRoute.id}`,
      payload: { modelPattern: 'claude-5-new' },
    });
    expect(renameResponse.statusCode).toBe(200);
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, oldPattern.id)).all()).toHaveLength(0);
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, newPattern.id)).all()).toContainEqual(expect.objectContaining({
        sourceModel: 'claude-5-new',
      }));

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/routes/${exactRoute.id}`,
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, newPattern.id)).all()).toHaveLength(0);
  });

  it('reconciles batch exact-route enable changes and pattern-route re-enable', async () => {
    const sourceA = await seedAccountWithToken('gpt-5-alpha');
    const sourceB = await seedAccountWithToken('gpt-5-beta');
    const manualSource = await seedAccountWithToken('manual-special');
    const exactRouteA = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-alpha',
      enabled: true,
    }).returning().get();
    const exactRouteB = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-beta',
      enabled: true,
    }).returning().get();
    const exactChannelA = await db.insert(schema.routeChannels).values({
      routeId: exactRouteA.id,
      accountId: sourceA.account.id,
      tokenId: sourceA.token.id,
      sourceModel: 'gpt-5-alpha',
      enabled: true,
      manualOverride: false,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: exactRouteB.id,
      accountId: sourceB.account.id,
      tokenId: sourceB.token.id,
      sourceModel: 'gpt-5-beta',
      enabled: true,
      manualOverride: false,
    }).run();
    const patternRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-*',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values([
      {
        routeId: patternRoute.id,
        accountId: sourceA.account.id,
        tokenId: sourceA.token.id,
        sourceModel: 'gpt-5-alpha',
        enabled: true,
        manualOverride: false,
      },
      {
        routeId: patternRoute.id,
        accountId: sourceB.account.id,
        tokenId: sourceB.token.id,
        sourceModel: 'gpt-5-beta',
        enabled: true,
        manualOverride: false,
      },
      {
        routeId: patternRoute.id,
        accountId: manualSource.account.id,
        tokenId: manualSource.token.id,
        sourceModel: 'manual-special',
        enabled: true,
        manualOverride: true,
      },
    ]).run();

    const disableResponse = await app.inject({
      method: 'POST',
      url: '/api/routes/batch',
      payload: {
        ids: [exactRouteA.id, exactRouteB.id],
        action: 'disable',
      },
    });
    expect(disableResponse.statusCode).toBe(200);
    let patternChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, patternRoute.id)).all();
    expect(patternChannels.map((channel) => channel.sourceModel)).toEqual(['manual-special']);

    const enableResponse = await app.inject({
      method: 'POST',
      url: '/api/routes/batch',
      payload: {
        ids: [exactRouteA.id, exactRouteB.id],
        action: 'enable',
      },
    });
    expect(enableResponse.statusCode).toBe(200);
    patternChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, patternRoute.id)).all();
    expect(patternChannels.map((channel) => channel.sourceModel).sort()).toEqual([
      'gpt-5-alpha',
      'gpt-5-beta',
      'manual-special',
    ]);

    await app.inject({
      method: 'PUT',
      url: `/api/routes/${patternRoute.id}`,
      payload: { enabled: false },
    });
    await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, exactChannelA.id)).run();
    await db.insert(schema.routeChannels).values({
      routeId: patternRoute.id,
      accountId: sourceA.account.id,
      tokenId: sourceA.token.id,
      sourceModel: 'stale-model',
      enabled: true,
      manualOverride: false,
    }).run();

    const reenableResponse = await app.inject({
      method: 'PUT',
      url: `/api/routes/${patternRoute.id}`,
      payload: { enabled: true },
    });
    expect(reenableResponse.statusCode).toBe(200);
    patternChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, patternRoute.id)).all();
    expect(patternChannels.map((channel) => channel.sourceModel).sort()).toEqual([
      'gpt-5-beta',
      'manual-special',
    ]);
  });

  it('prefers an explicit-group display name over a colliding exact route', async () => {
    const exactCandidate = await seedAccountWithToken('claude-opus-4-6');
    const groupedCandidate = await seedAccountWithToken('claude-opus-4-5');

    const exactRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-6',
      enabled: true,
    }).returning().get();
    const sourceRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-5',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values([
      {
        routeId: exactRoute.id,
        accountId: exactCandidate.account.id,
        tokenId: exactCandidate.token.id,
        sourceModel: 'claude-opus-4-6',
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      },
      {
        routeId: sourceRoute.id,
        accountId: groupedCandidate.account.id,
        tokenId: groupedCandidate.token.id,
        sourceModel: 'claude-opus-4-5',
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      },
    ]).run();

    const groupResponse = await app.inject({
      method: 'POST',
      url: '/api/routes',
      payload: {
        routeMode: 'explicit_group',
        displayName: 'claude-opus-4-6',
        sourceRouteIds: [sourceRoute.id],
      },
    });

    expect(groupResponse.statusCode).toBe(200);

    const decisionResponse = await app.inject({
      method: 'GET',
      url: '/api/routes/decision?model=claude-opus-4-6',
    });

    expect(decisionResponse.statusCode).toBe(200);
    expect(decisionResponse.json()).toMatchObject({
      success: true,
      decision: {
        matched: true,
        routeId: groupResponse.json().id,
        actualModel: 'claude-opus-4-5',
      },
    });
  });
});
