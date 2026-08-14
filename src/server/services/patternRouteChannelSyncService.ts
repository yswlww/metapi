import { and, eq, inArray } from 'drizzle-orm';
import { normalizeTokenRouteMode } from '../../shared/tokenRouteContract.js';
import { db, schema } from '../db/index.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  isUsableAccountToken,
} from './accountTokenService.js';
import { clearRouteDecisionSnapshots } from './routeDecisionSnapshotStore.js';
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
  priority: number;
  weight: number;
  enabled: boolean;
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

function buildChannelIdentity(input: {
  accountId: number;
  tokenId: number | null;
  oauthRouteUnitId: number | null;
  sourceModel: string | null;
}): string {
  const sourceModel = normalizeModelKey(input.sourceModel || '');
  if (input.oauthRouteUnitId && input.oauthRouteUnitId > 0) {
    return `route-unit:${input.oauthRouteUnitId}::${sourceModel}`;
  }
  return `account:${input.accountId}::${input.tokenId ?? 'account'}::${sourceModel}`;
}

function candidateIdentity(candidate: PatternRouteChannelCandidate): string {
  return buildChannelIdentity(candidate);
}

function channelIdentity(channel: ExistingChannel): string {
  return buildChannelIdentity({
    accountId: channel.accountId,
    tokenId: channel.tokenId ?? null,
    oauthRouteUnitId: channel.oauthRouteUnitId ?? null,
    sourceModel: channel.sourceModel,
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

async function reconcileRouteChannels(
  route: RouteIdentity,
  desiredCandidates: PatternRouteChannelCandidate[],
): Promise<{ createdChannels: number; removedChannels: number; changed: boolean }> {
  const existingChannels = (await db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.routeId, route.id))
    .all())
    .sort((left, right) => left.id - right.id);
  const desiredByIdentity = new Map(
    dedupeCandidates(desiredCandidates).map((candidate) => [candidateIdentity(candidate), candidate]),
  );
  const manualIdentities = new Set(
    existingChannels.filter((channel) => channel.manualOverride).map(channelIdentity),
  );
  const retainedAutomaticChannels = new Map<string, ExistingChannel>();
  const removableChannelIds: number[] = [];

  for (const channel of existingChannels) {
    if (channel.manualOverride) continue;
    const identity = channelIdentity(channel);
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
    await db.delete(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, removableChannelIds))
      .run();
  }

  let createdChannels = 0;
  let changed = removableChannelIds.length > 0;
  for (const [identity, candidate] of desiredByIdentity.entries()) {
    if (manualIdentities.has(identity)) continue;
    const existing = retainedAutomaticChannels.get(identity);
    if (!existing) {
      await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: candidate.accountId,
        tokenId: candidate.tokenId,
        oauthRouteUnitId: candidate.oauthRouteUnitId,
        sourceModel: candidate.sourceModel,
        priority: candidate.priority,
        weight: candidate.weight,
        enabled: candidate.enabled,
        manualOverride: false,
      }).run();
      createdChannels += 1;
      changed = true;
      continue;
    }

    const updates: Partial<typeof schema.routeChannels.$inferInsert> = {};
    if (existing.accountId !== candidate.accountId) updates.accountId = candidate.accountId;
    if ((existing.tokenId ?? null) !== candidate.tokenId) updates.tokenId = candidate.tokenId;
    if ((existing.oauthRouteUnitId ?? null) !== candidate.oauthRouteUnitId) {
      updates.oauthRouteUnitId = candidate.oauthRouteUnitId;
    }
    if ((existing.priority ?? 0) !== candidate.priority) updates.priority = candidate.priority;
    if ((existing.weight ?? 10) !== candidate.weight) updates.weight = candidate.weight;
    if (!!existing.enabled !== candidate.enabled) updates.enabled = candidate.enabled;

    if (Object.keys(updates).length > 0) {
      await db.update(schema.routeChannels)
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

async function listEnabledPatternRoutes(routeIds?: number[]): Promise<RouteIdentity[]> {
  const normalizedRouteIds = normalizeRouteIds(routeIds);
  if (routeIds && normalizedRouteIds.length === 0) return [];

  const rows = normalizedRouteIds.length > 0
    ? await db.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
      routeMode: schema.tokenRoutes.routeMode,
      enabled: schema.tokenRoutes.enabled,
    }).from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, normalizedRouteIds))
      .all()
    : await db.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
      routeMode: schema.tokenRoutes.routeMode,
      enabled: schema.tokenRoutes.enabled,
    }).from(schema.tokenRoutes).all();

  return rows.filter((route): route is RouteIdentity => !!route.enabled && isPatternRoute(route));
}

export async function reconcilePatternRouteChannels(
  input: ReconcilePatternRouteChannelsInput,
): Promise<PatternRouteChannelSyncResult> {
  const patternRoutes = await listEnabledPatternRoutes(input.patternRouteIds);
  if (patternRoutes.length === 0) return emptySyncResult();

  const result = emptySyncResult();
  const changedRouteIds: number[] = [];
  for (const route of patternRoutes) {
    const routeResult = await reconcileRouteChannels(
      route,
      input.desiredCandidates.filter((candidate) => candidateMatchesRoute(candidate, route)),
    );
    result.rebuiltRoutes += 1;
    result.createdChannels += routeResult.createdChannels;
    result.removedChannels += routeResult.removedChannels;
    if (routeResult.changed) changedRouteIds.push(route.id);
  }

  if (changedRouteIds.length > 0) {
    await clearRouteDecisionSnapshots(changedRouteIds);
  }
  return result;
}

async function loadAvailabilityCandidates(
  excludedExactModelPatterns: Set<string>,
): Promise<PatternRouteChannelCandidate[]> {
  const rows = await db.select().from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      eq(schema.tokenModelAvailability.available, true),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
    ))
    .all();

  const candidates: PatternRouteChannelCandidate[] = [];
  for (const row of rows) {
    if (!isUsableAccountToken(row.account_tokens)) continue;
    const modelName = row.token_model_availability.modelName?.trim();
    if (!modelName || excludedExactModelPatterns.has(normalizeModelKey(modelName))) continue;
    candidates.push({
      accountId: row.accounts.id,
      tokenId: row.account_tokens.id,
      oauthRouteUnitId: null,
      sourceModel: modelName,
      matchModel: modelName,
      priority: 0,
      weight: 10,
      enabled: true,
    });
  }
  return candidates;
}

async function loadExactTopologyCandidates(
  previousExactModelPatterns: string[] = [],
): Promise<PatternRouteChannelCandidate[]> {
  const exactRoutes = (await db.select({
    id: schema.tokenRoutes.id,
    modelPattern: schema.tokenRoutes.modelPattern,
    routeMode: schema.tokenRoutes.routeMode,
    enabled: schema.tokenRoutes.enabled,
  }).from(schema.tokenRoutes).all())
    .filter((route) => isExactSourceRoute(route))
    .sort((left, right) => left.id - right.id);
  const excludedExactModelPatterns = new Set(previousExactModelPatterns.map(normalizeModelKey).filter(Boolean));
  for (const route of exactRoutes) {
    excludedExactModelPatterns.add(normalizeModelKey(route.modelPattern));
  }

  const enabledExactRoutes = exactRoutes.filter((route) => route.enabled);
  const channels = enabledExactRoutes.length > 0
    ? (await db.select().from(schema.routeChannels)
      .where(inArray(schema.routeChannels.routeId, enabledExactRoutes.map((route) => route.id)))
      .all())
      .sort((left, right) => left.id - right.id)
    : [];
  const routeById = new Map<number, RouteIdentity>();
  for (const route of enabledExactRoutes) {
    routeById.set(route.id, route);
  }
  const exactCandidates: PatternRouteChannelCandidate[] = [];
  for (const channel of channels) {
    const route = routeById.get(channel.routeId);
    if (!route) continue;
    const sourceModel = (channel.sourceModel || route.modelPattern).trim();
    if (!sourceModel) continue;
    exactCandidates.push({
      accountId: channel.accountId,
      tokenId: channel.tokenId ?? null,
      oauthRouteUnitId: channel.oauthRouteUnitId ?? null,
      sourceModel,
      matchModel: route.modelPattern,
      priority: channel.priority ?? 0,
      weight: channel.weight ?? 10,
      enabled: !!channel.enabled,
    });
  }

  const availabilityCandidates = await loadAvailabilityCandidates(excludedExactModelPatterns);
  return [...exactCandidates, ...availabilityCandidates];
}

export async function reconcileRouteChannelsByModelPattern(
  routeId: number,
  modelPattern: string,
): Promise<PatternRouteChannelSyncResult> {
  const route = await db.select({
    id: schema.tokenRoutes.id,
    modelPattern: schema.tokenRoutes.modelPattern,
    routeMode: schema.tokenRoutes.routeMode,
    enabled: schema.tokenRoutes.enabled,
  }).from(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.id, routeId))
    .get();
  if (!route || !route.enabled || normalizeTokenRouteMode(route.routeMode) === 'explicit_group') {
    return emptySyncResult();
  }

  const candidates = isExactModelPattern(modelPattern)
    ? (await loadAvailabilityCandidates(new Set()))
      .filter((candidate) => matchesModelPattern(candidate.matchModel || candidate.sourceModel, modelPattern))
    : (await loadExactTopologyCandidates())
      .filter((candidate) => matchesModelPattern(candidate.matchModel || candidate.sourceModel, modelPattern));
  const routeResult = await reconcileRouteChannels(route, candidates);
  if (routeResult.changed) {
    await clearRouteDecisionSnapshots([route.id]);
  }
  return {
    rebuiltRoutes: 1,
    createdChannels: routeResult.createdChannels,
    removedChannels: routeResult.removedChannels,
  };
}

export async function syncPatternRouteChannelsAfterAffectedRouteChanges(
  input: SyncPatternRouteChannelsAfterAffectedRouteChangesInput = {},
): Promise<PatternRouteChannelSyncResult> {
  const affectedRouteIds = normalizeRouteIds(input.affectedRouteIds);
  const previousRoutes = input.previousRoutes || [];
  if (affectedRouteIds.length === 0 && previousRoutes.length === 0) return emptySyncResult();

  const currentRoutes = affectedRouteIds.length > 0
    ? await db.select({
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

  const allPatternRoutes = await listEnabledPatternRoutes();
  const targetPatternRouteIds = new Set(directlyAffectedPatternRouteIds);
  for (const route of allPatternRoutes) {
    if (affectedExactModelPatterns.some((modelPattern) => matchesModelPattern(modelPattern, route.modelPattern))) {
      targetPatternRouteIds.add(route.id);
    }
  }
  if (targetPatternRouteIds.size === 0) return emptySyncResult();

  return reconcilePatternRouteChannels({
    desiredCandidates: await loadExactTopologyCandidates(previousExactModelPatterns),
    patternRouteIds: Array.from(targetPatternRouteIds),
  });
}
