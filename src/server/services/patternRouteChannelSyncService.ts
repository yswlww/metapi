import { and, eq, inArray, sql } from 'drizzle-orm';
import { normalizeTokenRouteMode } from '../../shared/tokenRouteContract.js';
import { db, runtimeDbDialect, schema } from '../db/index.js';
import { clearRouteDecisionSnapshots } from './routeDecisionSnapshotStore.js';
import {
  buildAutomaticRouteChannelIdentity,
  buildRouteChannelCandidateKey,
  loadFilteredRouteChannelCandidates,
  type DatabaseExecutor,
  type RouteChannelCandidate,
} from './routeChannelCandidateService.js';
import { matchesModelPattern } from './tokenRouter.js';

export type PatternRouteSnapshot = {
  id: number;
  modelPattern: string;
  routeMode: string | null;
  enabled: boolean;
};

export type PatternRouteChannelCandidate = {
  accountId: number;
  tokenId: number | null;
  oauthRouteUnitId: number | null;
  sourceModel: string;
  priority?: number;
  weight?: number;
  enabled?: boolean;
  matchModel?: string;
};

export type PatternRouteChannelSyncResult = {
  rebuiltRoutes: number;
  createdChannels: number;
  removedChannels: number;
};

type SyncPatternRouteChannelsAfterAffectedRouteChangesInput = {
  affectedRouteIds?: number[];
  previousRoutes?: PatternRouteSnapshot[];
};

type ReconcilePatternRouteChannelsInput = {
  desiredCandidates: PatternRouteChannelCandidate[];
  patternRouteIds?: number[];
};

type RouteIdentity = Pick<
  typeof schema.tokenRoutes.$inferSelect,
  'id' | 'modelPattern' | 'routeMode' | 'enabled'
>;

type ExistingChannel = typeof schema.routeChannels.$inferSelect;
type InternalPatternRouteChannelSyncResult = PatternRouteChannelSyncResult & {
  changedRouteIds: number[];
};

export type RouteTopologyMutationContext = {
  database: DatabaseExecutor;
  clearSnapshots(routeIds: number[]): Promise<void>;
  reconcileExactRoute(
    routeId: number,
    modelPattern: string,
    desiredCandidates?: PatternRouteChannelCandidate[],
  ): Promise<PatternRouteChannelSyncResult>;
  reconcilePatternRoutes(input: ReconcilePatternRouteChannelsInput): Promise<PatternRouteChannelSyncResult>;
  syncAffectedRoutes(input?: SyncPatternRouteChannelsAfterAffectedRouteChangesInput): Promise<PatternRouteChannelSyncResult>;
};

let reconciliationTail: Promise<void> = Promise.resolve();

async function withReconciliationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = reconciliationTail;
  let release: () => void = () => {};
  reconciliationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?]/.test(normalized);
}

function isExactSourceRoute(route: Pick<RouteIdentity, 'modelPattern' | 'routeMode'>): boolean {
  return normalizeTokenRouteMode(route.routeMode) !== 'explicit_group'
    && isExactModelPattern(route.modelPattern);
}

function isPatternRoute(route: Pick<RouteIdentity, 'modelPattern' | 'routeMode'>): boolean {
  return normalizeTokenRouteMode(route.routeMode) !== 'explicit_group'
    && !isExactModelPattern(route.modelPattern);
}

function normalizeModelKey(modelName: string): string {
  return modelName.trim().toLowerCase();
}

function normalizeRouteIds(routeIds: number[] | undefined): number[] {
  const normalized = new Set<number>();
  for (const rawRouteId of routeIds || []) {
    const routeId = Math.trunc(Number(rawRouteId));
    if (!Number.isFinite(routeId) || routeId <= 0) continue;
    normalized.add(routeId);
  }
  return Array.from(normalized);
}

function emptySyncResult(): PatternRouteChannelSyncResult {
  return {
    rebuiltRoutes: 0,
    createdChannels: 0,
    removedChannels: 0,
  };
}

function channelAutomaticIdentity(input: {
  accountId: number;
  tokenId: number | null;
  oauthRouteUnitId: number | null;
  sourceModel: string | null;
}): string {
  return buildAutomaticRouteChannelIdentity(input);
}

function candidateIdentity(candidate: PatternRouteChannelCandidate): string {
  return channelAutomaticIdentity(candidate);
}

function channelIdentity(channel: ExistingChannel, fallbackSourceModel: string | null = null): string {
  return channel.automaticIdentity || channelAutomaticIdentity({
    accountId: channel.accountId,
    tokenId: channel.tokenId ?? null,
    oauthRouteUnitId: channel.oauthRouteUnitId ?? null,
    sourceModel: channel.sourceModel || fallbackSourceModel,
  });
}

function candidateMatchesRoute(candidate: PatternRouteChannelCandidate, route: RouteIdentity): boolean {
  return matchesModelPattern(candidate.matchModel || candidate.sourceModel, route.modelPattern);
}

function dedupeCandidates(candidates: PatternRouteChannelCandidate[]): PatternRouteChannelCandidate[] {
  const candidatesByIdentity = new Map<string, PatternRouteChannelCandidate>();
  for (const candidate of candidates) {
    const sourceModel = candidate.sourceModel.trim();
    if (!sourceModel) continue;
    const normalizedCandidate = { ...candidate, sourceModel };
    const identity = candidateIdentity(normalizedCandidate);
    if (!candidatesByIdentity.has(identity)) {
      candidatesByIdentity.set(identity, normalizedCandidate);
    }
  }
  return Array.from(candidatesByIdentity.values());
}

async function insertAutomaticRouteChannel(
  database: DatabaseExecutor,
  routeId: number,
  candidate: PatternRouteChannelCandidate,
): Promise<{ channel: ExistingChannel | null; created: boolean }> {
  const automaticIdentity = candidateIdentity(candidate);
  const values = {
    routeId,
    accountId: candidate.accountId,
    tokenId: candidate.tokenId,
    oauthRouteUnitId: candidate.oauthRouteUnitId,
    sourceModel: candidate.sourceModel,
    automaticIdentity,
    priority: candidate.priority ?? 0,
    weight: candidate.weight ?? 10,
    enabled: candidate.enabled ?? true,
    manualOverride: false,
  };
  let result;
  if (runtimeDbDialect === 'mysql') {
    result = await (database.insert(schema.routeChannels).values(values) as any)
      .onDuplicateKeyUpdate({
        set: { automaticIdentity: sql`${schema.routeChannels.automaticIdentity}` },
      })
      .run();
  } else {
    result = await (database.insert(schema.routeChannels).values(values) as any)
      .onConflictDoNothing({
        target: [schema.routeChannels.routeId, schema.routeChannels.automaticIdentity],
      })
      .run();
  }
  const channel = await database.select().from(schema.routeChannels)
    .where(and(
      eq(schema.routeChannels.routeId, routeId),
      eq(schema.routeChannels.automaticIdentity, automaticIdentity),
    ))
    .get();
  return {
    channel: channel ?? null,
    created: Number(result?.changes || 0) > 0,
  };
}

async function reconcileRouteChannels(
  database: DatabaseExecutor,
  route: RouteIdentity,
  desiredCandidates: PatternRouteChannelCandidate[],
): Promise<{ createdChannels: number; removedChannels: number; changed: boolean }> {
  const existingChannels = (await database.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.routeId, route.id))
    .all())
    .sort((left, right) => left.id - right.id);
  const desiredByIdentity = new Map(
    dedupeCandidates(desiredCandidates).map((candidate) => [candidateIdentity(candidate), candidate]),
  );
  const identitySourceModel = isExactModelPattern(route.modelPattern) ? route.modelPattern : null;
  const manualIdentities = new Set(
    existingChannels
      .filter((channel) => channel.manualOverride)
      .map((channel) => channelIdentity(channel, identitySourceModel)),
  );
  const retainedAutomaticChannels = new Map<string, ExistingChannel>();
  const removableChannelIds: number[] = [];

  for (const channel of existingChannels) {
    if (channel.manualOverride) continue;
    const identity = channelIdentity(channel, identitySourceModel);
    if (
      manualIdentities.has(identity)
      || !desiredByIdentity.has(identity)
      || retainedAutomaticChannels.has(identity)
    ) {
      removableChannelIds.push(channel.id);
      continue;
    }
    retainedAutomaticChannels.set(identity, channel);
  }

  if (removableChannelIds.length > 0) {
    await database.delete(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, removableChannelIds))
      .run();
  }

  let createdChannels = 0;
  let changed = removableChannelIds.length > 0;
  for (const [identity, candidate] of desiredByIdentity.entries()) {
    if (manualIdentities.has(identity)) continue;
    let existing = retainedAutomaticChannels.get(identity);
    if (!existing) {
      const inserted = await insertAutomaticRouteChannel(database, route.id, candidate);
      existing = inserted.channel ?? undefined;
      if (!existing) continue;
      retainedAutomaticChannels.set(identity, existing);
      if (inserted.created) {
        createdChannels += 1;
        changed = true;
      }
    }

    const updates: Partial<typeof schema.routeChannels.$inferInsert> = {};
    if (existing.automaticIdentity !== identity) updates.automaticIdentity = identity;
    if (!(existing.sourceModel || '').trim()) updates.sourceModel = candidate.sourceModel;
    if (existing.accountId !== candidate.accountId) updates.accountId = candidate.accountId;
    if ((existing.tokenId ?? null) !== candidate.tokenId) updates.tokenId = candidate.tokenId;
    if ((existing.oauthRouteUnitId ?? null) !== candidate.oauthRouteUnitId) {
      updates.oauthRouteUnitId = candidate.oauthRouteUnitId;
    }
    if (candidate.priority !== undefined && (existing.priority ?? 0) !== candidate.priority) {
      updates.priority = candidate.priority;
    }
    if (candidate.weight !== undefined && (existing.weight ?? 10) !== candidate.weight) {
      updates.weight = candidate.weight;
    }
    if (candidate.enabled !== undefined && !!existing.enabled !== candidate.enabled) {
      updates.enabled = candidate.enabled;
    }

    if (Object.keys(updates).length > 0) {
      await database.update(schema.routeChannels)
        .set(updates)
        .where(eq(schema.routeChannels.id, existing.id))
        .run();
      changed = true;
    }
  }

  return {
    createdChannels,
    removedChannels: removableChannelIds.length,
    changed,
  };
}

async function listEnabledPatternRoutes(
  database: DatabaseExecutor,
  routeIds?: number[],
): Promise<RouteIdentity[]> {
  const normalizedRouteIds = normalizeRouteIds(routeIds);
  if (routeIds && normalizedRouteIds.length === 0) return [];

  const rows = normalizedRouteIds.length > 0
    ? await database.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
      routeMode: schema.tokenRoutes.routeMode,
      enabled: schema.tokenRoutes.enabled,
    }).from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, normalizedRouteIds))
      .all()
    : await database.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
      routeMode: schema.tokenRoutes.routeMode,
      enabled: schema.tokenRoutes.enabled,
    }).from(schema.tokenRoutes).all();

  return rows.filter((route): route is RouteIdentity => !!route.enabled && isPatternRoute(route));
}

async function reconcilePatternRouteChannelsInTransaction(
  database: DatabaseExecutor,
  input: ReconcilePatternRouteChannelsInput,
): Promise<InternalPatternRouteChannelSyncResult> {
  const patternRoutes = await listEnabledPatternRoutes(database, input.patternRouteIds);
  if (patternRoutes.length === 0) {
    return { ...emptySyncResult(), changedRouteIds: [] };
  }

  const result = emptySyncResult();
  const changedRouteIds: number[] = [];
  for (const route of patternRoutes) {
    const routeResult = await reconcileRouteChannels(
      database,
      route,
      input.desiredCandidates.filter((candidate) => candidateMatchesRoute(candidate, route)),
    );
    result.rebuiltRoutes += 1;
    result.createdChannels += routeResult.createdChannels;
    result.removedChannels += routeResult.removedChannels;
    if (routeResult.changed) changedRouteIds.push(route.id);
  }

  return { ...result, changedRouteIds };
}

function publicSyncResult(result: InternalPatternRouteChannelSyncResult): PatternRouteChannelSyncResult {
  return {
    rebuiltRoutes: result.rebuiltRoutes,
    createdChannels: result.createdChannels,
    removedChannels: result.removedChannels,
  };
}

function toPatternCandidate(candidate: RouteChannelCandidate): PatternRouteChannelCandidate {
  return {
    accountId: candidate.accountId,
    tokenId: candidate.tokenId,
    oauthRouteUnitId: candidate.oauthRouteUnitId,
    sourceModel: candidate.modelName,
    matchModel: candidate.modelName,
    priority: 0,
    weight: 10,
    enabled: true,
  };
}

async function loadExactTopologyCandidates(
  database: DatabaseExecutor,
  previousExactModelPatterns: string[] = [],
): Promise<PatternRouteChannelCandidate[]> {
  const filteredCandidates = await loadFilteredRouteChannelCandidates(database);
  const candidatesByModel = new Map<string, Map<string, RouteChannelCandidate>>();
  for (const candidate of filteredCandidates) {
    const modelKey = normalizeModelKey(candidate.modelName);
    const candidates = candidatesByModel.get(modelKey) ?? new Map<string, RouteChannelCandidate>();
    candidates.set(buildRouteChannelCandidateKey(candidate), candidate);
    candidatesByModel.set(modelKey, candidates);
  }

  const exactRoutes = (await database.select({
    id: schema.tokenRoutes.id,
    modelPattern: schema.tokenRoutes.modelPattern,
    routeMode: schema.tokenRoutes.routeMode,
    enabled: schema.tokenRoutes.enabled,
  }).from(schema.tokenRoutes).all())
    .filter((route) => isExactSourceRoute(route))
    .sort((left, right) => left.id - right.id);
  const exactModelPatterns = new Set(previousExactModelPatterns.map(normalizeModelKey).filter(Boolean));
  for (const route of exactRoutes) exactModelPatterns.add(normalizeModelKey(route.modelPattern));

  const enabledExactRoutes = exactRoutes.filter((route) => route.enabled);
  const channels = enabledExactRoutes.length > 0
    ? (await database.select().from(schema.routeChannels)
      .where(inArray(schema.routeChannels.routeId, enabledExactRoutes.map((route) => route.id)))
      .all())
      .sort((left, right) => left.id - right.id)
    : [];
  const routeById = new Map<number, RouteIdentity>();
  for (const route of enabledExactRoutes) routeById.set(route.id, route);
  const oauthRouteUnitIds: number[] = Array.from(new Set<number>(
    channels
      .map((channel) => Number(channel.oauthRouteUnitId || 0))
      .filter((routeUnitId) => routeUnitId > 0),
  ));
  const routeUnitMemberRows = oauthRouteUnitIds.length > 0
    ? await database.select({
      unitId: schema.oauthRouteUnitMembers.unitId,
      accountId: schema.oauthRouteUnitMembers.accountId,
    }).from(schema.oauthRouteUnitMembers)
      .where(inArray(schema.oauthRouteUnitMembers.unitId, oauthRouteUnitIds))
      .all()
    : [];
  const memberAccountIdsByUnitId = new Map<number, Set<number>>();
  for (const row of routeUnitMemberRows) {
    const accountIds = memberAccountIdsByUnitId.get(row.unitId) ?? new Set<number>();
    accountIds.add(row.accountId);
    memberAccountIdsByUnitId.set(row.unitId, accountIds);
  }
  const exactCandidates: PatternRouteChannelCandidate[] = [];
  for (const channel of channels) {
    const route = routeById.get(channel.routeId);
    if (!route) continue;
    const candidatesForModel = candidatesByModel.get(normalizeModelKey(route.modelPattern));
    let canonical = candidatesForModel?.get(buildRouteChannelCandidateKey({
      accountId: channel.accountId,
      tokenId: channel.tokenId ?? null,
      oauthRouteUnitId: channel.oauthRouteUnitId ?? null,
    }));
    if (!canonical && channel.oauthRouteUnitId) {
      const memberAccountIds = memberAccountIdsByUnitId.get(channel.oauthRouteUnitId);
      canonical = Array.from(candidatesForModel?.values() ?? [])
        .find((candidate) => memberAccountIds?.has(candidate.accountId));
    }
    if (!canonical) continue;
    const sourceModel = (channel.sourceModel || canonical.modelName).trim();
    if (!sourceModel) continue;
    exactCandidates.push({
      accountId: channel.oauthRouteUnitId
        ? (canonical.oauthRouteUnitId ? canonical.accountId : channel.accountId)
        : canonical.accountId,
      tokenId: channel.oauthRouteUnitId ? null : canonical.tokenId,
      oauthRouteUnitId: channel.oauthRouteUnitId ?? canonical.oauthRouteUnitId,
      sourceModel,
      matchModel: route.modelPattern,
      priority: channel.priority ?? 0,
      weight: channel.weight ?? 10,
      enabled: !!channel.enabled,
    });
  }

  const fallbackCandidates = filteredCandidates
    .filter((candidate) => !exactModelPatterns.has(normalizeModelKey(candidate.modelName)))
    .map(toPatternCandidate);
  return [...exactCandidates, ...fallbackCandidates];
}

async function reconcileRouteChannelsByModelPatternInTransaction(
  database: DatabaseExecutor,
  routeId: number,
  modelPattern: string,
  desiredCandidates?: PatternRouteChannelCandidate[],
): Promise<InternalPatternRouteChannelSyncResult> {
  const route = await database.select({
    id: schema.tokenRoutes.id,
    modelPattern: schema.tokenRoutes.modelPattern,
    routeMode: schema.tokenRoutes.routeMode,
    enabled: schema.tokenRoutes.enabled,
  }).from(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.id, routeId))
    .get();
  if (!route || !route.enabled || normalizeTokenRouteMode(route.routeMode) === 'explicit_group') {
    return { ...emptySyncResult(), changedRouteIds: [] };
  }

  const candidates = desiredCandidates ?? (await loadFilteredRouteChannelCandidates(database))
    .filter((candidate) => matchesModelPattern(candidate.modelName, modelPattern))
    .map(toPatternCandidate);
  const routeResult = await reconcileRouteChannels(database, route, candidates);
  return {
    rebuiltRoutes: 1,
    createdChannels: routeResult.createdChannels,
    removedChannels: routeResult.removedChannels,
    changedRouteIds: routeResult.changed ? [route.id] : [],
  };
}

async function syncPatternRouteChannelsAfterAffectedRouteChangesInTransaction(
  database: DatabaseExecutor,
  input: SyncPatternRouteChannelsAfterAffectedRouteChangesInput = {},
): Promise<InternalPatternRouteChannelSyncResult> {
  const affectedRouteIds = normalizeRouteIds(input.affectedRouteIds);
  const previousRoutes = input.previousRoutes || [];
  if (affectedRouteIds.length === 0 && previousRoutes.length === 0) {
    return { ...emptySyncResult(), changedRouteIds: [] };
  }

  const currentRoutes = affectedRouteIds.length > 0
    ? await database.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
      routeMode: schema.tokenRoutes.routeMode,
      enabled: schema.tokenRoutes.enabled,
    }).from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, affectedRouteIds))
      .all()
    : [];
  const affectedExactModelPatterns: string[] = [];
  const previousExactModelPatterns: string[] = [];
  const directlyAffectedPatternRouteIds = new Set<number>();

  for (const route of previousRoutes) {
    if (route.enabled && isExactSourceRoute(route)) {
      affectedExactModelPatterns.push(route.modelPattern);
      previousExactModelPatterns.push(route.modelPattern);
    }
  }
  for (const route of currentRoutes) {
    if (route.enabled && isExactSourceRoute(route)) {
      affectedExactModelPatterns.push(route.modelPattern);
    } else if (route.enabled && isPatternRoute(route)) {
      directlyAffectedPatternRouteIds.add(route.id);
    }
  }

  const allPatternRoutes = await listEnabledPatternRoutes(database);
  const targetPatternRouteIds = new Set(directlyAffectedPatternRouteIds);
  for (const route of allPatternRoutes) {
    if (affectedExactModelPatterns.some((modelPattern) => matchesModelPattern(modelPattern, route.modelPattern))) {
      targetPatternRouteIds.add(route.id);
    }
  }
  if (targetPatternRouteIds.size === 0) {
    return { ...emptySyncResult(), changedRouteIds: [] };
  }

  return reconcilePatternRouteChannelsInTransaction(database, {
    desiredCandidates: await loadExactTopologyCandidates(database, previousExactModelPatterns),
    patternRouteIds: Array.from(targetPatternRouteIds),
  });
}

export async function mutateRouteTopology<T>(
  operation: (context: RouteTopologyMutationContext) => Promise<T>,
): Promise<T> {
  return withReconciliationLock(async () => db.transaction(async (transaction: DatabaseExecutor) => {
    const changedRouteIds = new Set<number>();
    const track = (result: InternalPatternRouteChannelSyncResult) => {
      for (const routeId of result.changedRouteIds) changedRouteIds.add(routeId);
      return publicSyncResult(result);
    };
    const context: RouteTopologyMutationContext = {
      database: transaction,
      clearSnapshots: async (routeIds) => clearRouteDecisionSnapshots(routeIds, transaction),
      reconcileExactRoute: async (routeId, modelPattern, desiredCandidates) => track(
        await reconcileRouteChannelsByModelPatternInTransaction(
          transaction,
          routeId,
          modelPattern,
          desiredCandidates,
        ),
      ),
      reconcilePatternRoutes: async (input) => track(
        await reconcilePatternRouteChannelsInTransaction(transaction, input),
      ),
      syncAffectedRoutes: async (input) => track(
        await syncPatternRouteChannelsAfterAffectedRouteChangesInTransaction(transaction, input),
      ),
    };
    const result = await operation(context);
    if (changedRouteIds.size > 0) {
      await clearRouteDecisionSnapshots(Array.from(changedRouteIds), transaction);
    }
    return result;
  }));
}

export async function reconcilePatternRouteChannels(
  input: ReconcilePatternRouteChannelsInput,
): Promise<PatternRouteChannelSyncResult> {
  return mutateRouteTopology((context) => context.reconcilePatternRoutes(input));
}

export async function reconcileRouteChannelsByModelPattern(
  routeId: number,
  modelPattern: string,
): Promise<PatternRouteChannelSyncResult> {
  return mutateRouteTopology((context) => context.reconcileExactRoute(routeId, modelPattern));
}

export async function syncPatternRouteChannelsAfterAffectedRouteChanges(
  input: SyncPatternRouteChannelsAfterAffectedRouteChangesInput = {},
): Promise<PatternRouteChannelSyncResult> {
  return mutateRouteTopology((context) => context.syncAffectedRoutes(input));
}
