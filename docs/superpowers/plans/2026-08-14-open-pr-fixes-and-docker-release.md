# Open PR Fixes and Docker Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate only the still-valid fixes from the open upstream PR queue into the `1d6a83f` fork baseline, verify them, update `yswlww/metapi`, and publish a matching `kennethww/metapi` Docker image.

**Architecture:** Keep existing runtime behavior and data ownership intact. Adapt small PRs directly to current code, introduce opt-in schema changes with backward-compatible defaults, and route exact-route topology changes through one pattern-route reconciliation service rather than copying stale PR implementations. Already-integrated PRs are verified but not duplicated.

**Tech Stack:** TypeScript 6, Fastify 5, Drizzle ORM, Vitest, React 18, Docker Compose, Helm templates, GitHub Actions.

## Global Constraints

- Base all changes on commit `1d6a83fde88b97e57f8f7cfca58beb58ad648dab`.
- Preserve `kennethww/metapi` image references.
- Preserve Docker `linux/arm/v7` support; keep `node:22-bookworm-slim` in `docker/Dockerfile`.
- Do not merge PR #588's unrelated route-visibility or GHCR workflow commits.
- Preserve existing `manualOverride` route channels and OAuth route-unit identity.
- Database/UI settings continue to override environment defaults after runtime hydration.
- Do not weaken required `AUTH_TOKEN` and `PROXY_TOKEN` guards in Docker Compose.
- Every behavioral change must have a failing regression test before implementation.
- Run the full test suite, typecheck, build, Docker build, and live image inspection before publishing completion.

---

### Task 1: Record PR disposition and verify already-integrated fixes

**Files:**
- Create: `docs/superpowers/plans/2026-08-14-open-pr-fixes-and-docker-release.md`
- Test: existing targeted tests only

**Interfaces:**
- Consumes: current HEAD and upstream PR metadata.
- Produces: explicit integration scope for Tasks 2-7.

- [ ] **Step 1: Verify already-integrated MySQL snapshot upsert**

Run:

```bash
npx vitest run --root . \
  src/server/services/adminSnapshotStore.mysql.test.ts \
  src/server/services/adminSnapshotStore.test.ts
```

Expected: PASS; `adminSnapshotStore.ts` selects `onDuplicateKeyUpdate` for MySQL.

- [ ] **Step 2: Verify already-integrated Gemini thought-signature bridge**

Run:

```bash
npx vitest run --root . \
  src/server/transformers/gemini/generate-content/requestBridge.thoughtSignature.test.ts \
  src/server/transformers/gemini/generate-content/index.test.ts
```

Expected: PASS; no code copied from PR #581.

- [ ] **Step 3: Verify already-integrated New API cookie and downstream-key behavior**

Run:

```bash
npx vitest run --root . \
  src/server/services/platforms/newApi.test.ts \
  src/server/services/downstreamApiKeyService.test.ts \
  src/web/pages/DownstreamKeys.test.tsx
```

Expected: PASS; no code copied from PR #550.

- [ ] **Step 4: Keep rejected/partial PRs out of the patch**

Do not apply:

```text
#557 node:26 Docker base — rejects arm/v7 support
#520 remaining model context-length feature — feature scope, not a current defect
#588 route-list hiding and publish-ghcr commits — unrelated and unresolved
```

### Task 2: Telegram base URL and Docker Compose forwarding

**Files:**
- Modify: `src/server/config.ts`
- Modify: `src/server/config.test.ts`
- Modify: `.env.example`
- Modify: `docker/.env.example`
- Modify: `docker/docker-compose.yml`
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/configuration.md`
- Modify: `scripts/dev/docker.workflow.test.ts`

**Interfaces:**
- Consumes: `buildConfig(env: NodeJS.ProcessEnv)`.
- Produces: `telegramApiBaseUrl` from `TELEGRAM_API_BASE_URL`, normalized by trimming whitespace and trailing slashes with official endpoint fallback.
- Produces: Docker Compose environment contract that forwards every variable documented in `docker/.env.example`.

- [ ] **Step 1: Add failing config tests**

Extend `src/server/config.test.ts` with assertions equivalent to:

```ts
expect(buildConfig({ TELEGRAM_API_BASE_URL: ' https://tg.example/api/// ' }).telegramApiBaseUrl)
  .toBe('https://tg.example/api');
expect(buildConfig({ TELEGRAM_API_BASE_URL: '   ' }).telegramApiBaseUrl)
  .toBe('https://api.telegram.org');
```

- [ ] **Step 2: Run config tests and verify failure**

Run:

```bash
npx vitest run --root . src/server/config.test.ts
```

Expected: FAIL because current code hardcodes `https://api.telegram.org`.

- [ ] **Step 3: Implement minimal config override**

Change the config field to:

```ts
telegramApiBaseUrl:
  (env.TELEGRAM_API_BASE_URL || '').trim().replace(/\/+$/, '') || 'https://api.telegram.org',
```

Keep persisted runtime-setting precedence unchanged.

- [ ] **Step 4: Add failing Docker contract tests**

Extend `scripts/dev/docker.workflow.test.ts` to read `docker/.env.example`, `docker/docker-compose.yml`, and embedded Compose examples. Assert forwarding for:

```text
ACCOUNT_CREDENTIAL_SECRET
CHECKIN_CRON
BALANCE_REFRESH_CRON
NOTIFY_COOLDOWN_SEC
ADMIN_IP_ALLOWLIST
SYSTEM_PROXY_URL
TELEGRAM_ENABLED
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_API_BASE_URL
TELEGRAM_MESSAGE_THREAD_ID
TELEGRAM_USE_SYSTEM_PROXY
TZ
PORT
```

Assert `PORT` controls both published and target port and `AUTH_TOKEN`/`PROXY_TOKEN` retain `:?` guards.

- [ ] **Step 5: Run Docker contract tests and verify failure**

Run:

```bash
npx vitest run --root . scripts/dev/docker.workflow.test.ts
```

Expected: FAIL on missing forwarding and hardcoded cron/port values.

- [ ] **Step 6: Update Compose and examples**

Use explicit mappings, including:

```yaml
ports:
  - "127.0.0.1:${PORT:-4000}:${PORT:-4000}"
environment:
  AUTH_TOKEN: ${AUTH_TOKEN:?AUTH_TOKEN is required}
  PROXY_TOKEN: ${PROXY_TOKEN:?PROXY_TOKEN is required}
  ACCOUNT_CREDENTIAL_SECRET: "${ACCOUNT_CREDENTIAL_SECRET:-}"
  CHECKIN_CRON: "${CHECKIN_CRON:-0 8 * * *}"
  BALANCE_REFRESH_CRON: "${BALANCE_REFRESH_CRON:-0 * * * *}"
  PORT: ${PORT:-4000}
  DATA_DIR: /app/data
  TZ: ${TZ:-Asia/Shanghai}
  NOTIFY_COOLDOWN_SEC: ${NOTIFY_COOLDOWN_SEC:-300}
  ADMIN_IP_ALLOWLIST: "${ADMIN_IP_ALLOWLIST:-}"
  SYSTEM_PROXY_URL: "${SYSTEM_PROXY_URL:-}"
  TELEGRAM_ENABLED: ${TELEGRAM_ENABLED:-false}
  TELEGRAM_BOT_TOKEN: "${TELEGRAM_BOT_TOKEN:-}"
  TELEGRAM_CHAT_ID: "${TELEGRAM_CHAT_ID:-}"
  TELEGRAM_API_BASE_URL: "${TELEGRAM_API_BASE_URL:-}"
  TELEGRAM_MESSAGE_THREAD_ID: "${TELEGRAM_MESSAGE_THREAD_ID:-}"
  TELEGRAM_USE_SYSTEM_PROXY: ${TELEGRAM_USE_SYSTEM_PROXY:-false}
```

Mirror the supported contract in `.env.example`, `docker/.env.example`, README files, and getting-started documentation.

- [ ] **Step 7: Verify Compose rendering**

Run:

```bash
env AUTH_TOKEN=test-admin PROXY_TOKEN=test-proxy PORT=4567 \
  CHECKIN_CRON='5 6 * * 1' BALANCE_REFRESH_CRON='7 * * * *' \
  TELEGRAM_ENABLED=true TELEGRAM_BOT_TOKEN='123:abc' TELEGRAM_CHAT_ID='@channel' \
  TELEGRAM_API_BASE_URL='https://tg.example/api' \
  docker compose -f docker/docker-compose.yml config
```

Expected: rendered environment contains all overrides and port `4567:4567`.

### Task 3: Site custom-header override priority

**Files:**
- Modify: `src/server/db/schema.ts`
- Create: `drizzle/0027_site_custom_headers_override_request_headers.sql`
- Modify: `drizzle/meta/_journal.json`
- Regenerate: `src/server/db/generated/*`
- Modify: `src/server/db/siteSchemaCompatibility.ts`
- Modify: `src/server/contracts/siteRoutePayloads.ts`
- Modify: `src/server/routes/api/sites.ts`
- Modify: `src/server/services/siteCustomHeaders.ts`
- Modify: `src/server/services/siteProxy.ts`
- Modify: backup/migration services and tests that serialize sites
- Modify: `src/web/pages/Sites.tsx`
- Modify: `src/web/pages/helpers/sitesEditor.ts`
- Test: `src/server/services/siteCustomHeaders.test.ts`
- Test: `src/server/services/siteProxy.test.ts`
- Test: site API/editor/backup/migration/schema tests

**Interfaces:**
- Produces schema field `customHeadersOverrideRequestHeaders: boolean`, default `false`.
- Produces `mergeHeadersWithSiteCustomHeaders(siteCustomHeaders, requestHeaders, { priority })` where `priority` is `'request' | 'site'`.

- [ ] **Step 1: Add failing merge-priority tests**

Create tests proving default request-header priority and opt-in site-header priority:

```ts
expect(new Headers(mergeHeadersWithSiteCustomHeaders(site, request)).get('user-agent'))
  .toBe('request-agent');
expect(new Headers(mergeHeadersWithSiteCustomHeaders(site, request, { priority: 'site' })).get('user-agent'))
  .toBe('site-agent');
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run --root . \
  src/server/services/siteCustomHeaders.test.ts \
  src/server/services/siteProxy.test.ts
```

Expected: FAIL because options and persisted flag do not exist.

- [ ] **Step 3: Implement merge option and persisted flag**

Add the opt-in boolean across schema, API payloads, site cache/query records, backup/import, database migration statements, and UI editor. Preserve default `false` so existing sites retain current request-header precedence.

- [ ] **Step 4: Generate schema artifacts**

Run:

```bash
npm run schema:generate
```

Expected: migration journal, generated bootstrap/upgrade SQL, and schema contract are consistent.

- [ ] **Step 5: Run targeted schema and feature tests**

Run:

```bash
npx vitest run --root . \
  src/server/services/siteCustomHeaders.test.ts \
  src/server/services/siteProxy.test.ts \
  src/server/routes/api/sites.proxyUrl.test.ts \
  src/server/services/backupService.test.ts \
  src/server/services/databaseMigrationService.test.ts \
  src/server/db/schemaContract.test.ts \
  src/server/db/siteSchemaCompatibility.test.ts \
  src/web/pages/helpers/sitesEditor.test.ts
```

Expected: PASS.

### Task 4: Synchronize pattern routes after exact topology mutations

**Files:**
- Create: `src/server/services/patternRouteChannelSyncService.ts`
- Create: `src/server/services/patternRouteChannelSyncService.affected-routes.test.ts`
- Modify: `src/server/routes/api/tokens.ts`
- Modify: `src/server/routes/api/tokens.route-update-rebuild.test.ts`
- Modify: `src/server/services/modelService.ts`
- Modify: `src/server/services/modelService.test.ts`
- Modify: `src/server/routes/api/routeRefreshWorkflow.architecture.test.ts`

**Interfaces:**
- Produces `syncPatternRouteChannelsAfterAffectedRouteChanges(input): Promise<{ rebuiltRoutes: number; createdChannels: number; removedChannels: number }>`.
- Input contains affected route IDs and pre-change snapshots `{ id, modelPattern, routeMode, enabled }`.
- Reconciliation preserves unchanged rows, `manualOverride`, `oauthRouteUnitId`, channel telemetry/IDs, and current modelService filtering.

- [ ] **Step 1: Add failing route-mutation tests**

Cover exact route/channel update, disable, delete, batch mutation, and pattern-group re-enable. Assert stale automatic channels disappear and valid/manual/OAuth channels remain.

- [ ] **Step 2: Run targeted tests and verify failure**

Run:

```bash
npx vitest run --root . \
  src/server/routes/api/tokens.route-update-rebuild.test.ts \
  src/server/services/modelService.test.ts
```

Expected: new cases fail because current handlers only clear caches/snapshots.

- [ ] **Step 3: Extract one reconciliation owner**

Move pattern candidate/diff logic behind `patternRouteChannelSyncService.ts`. Do not use PR #588's delete-all/reinsert algorithm. Reuse current alias matching and filtered candidate state; retain existing channel rows when their identity is still desired.

- [ ] **Step 4: Delegate all exact topology mutation paths**

Call the service after:

```text
single/batch channel add
channel priority/weight/enabled/token/sourceModel update
single/batch channel priority update
channel delete
exact route rename/enable/disable/delete
batch route enable/disable
pattern route re-enable
```

- [ ] **Step 5: Share reconciler with full model rebuild**

Replace competing wildcard/regex reconciliation in `modelService.ts` with the same diff primitive while passing its already-filtered desired candidates.

- [ ] **Step 6: Run routing tests**

Run:

```bash
npx vitest run --root . \
  src/server/services/patternRouteChannelSyncService.affected-routes.test.ts \
  src/server/routes/api/tokens.route-update-rebuild.test.ts \
  src/server/services/modelService.test.ts \
  src/server/routes/api/routeRefreshWorkflow.architecture.test.ts \
  src/server/services/tokenRouter.patterns.test.ts
```

Expected: PASS without changing route-list visibility semantics.

### Task 5: Hardened Helm existingSecret support

**Files:**
- Modify: `deploy/k3s/chart/values.yaml`
- Modify: `deploy/k3s/chart/templates/_helpers.tpl`
- Modify: `deploy/k3s/chart/templates/deployment.yaml`
- Modify: `deploy/k3s/chart/templates/secret.yaml`
- Modify: `docs/k3s-update-center.md`
- Modify: `src/server/update-helper/k3sAssets.test.ts`

**Interfaces:**
- Produces Helm value `existingSecret: ""`.
- Produces helper `metapi.envSecretRefName`.
- Existing-secret mode skips chart Secret and checksum; managed mode is unchanged.

- [ ] **Step 1: Add failing template contract assertions**

Assert exact helper use, conditional checksum/Secret rendering, and quoted external secret reference.

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npx vitest run --root . src/server/update-helper/k3sAssets.test.ts
```

Expected: FAIL because `existingSecret` mode does not exist.

- [ ] **Step 3: Implement hardened templates**

Use:

```yaml
name: {{ include "metapi.envSecretRefName" . | quote }}
```

Skip `secret.yaml` and `checksum/env-secret` only when `existingSecret` is non-empty. Keep required managed-secret validations unchanged.

- [ ] **Step 4: Correct documentation semantics**

Document that `envFrom` does not validate required keys; incomplete external Secrets may trigger application defaults. Require a dedicated same-namespace Secret, warn about known fallback tokens, Helm history, same-name adoption, and manual rollout on external Secret rotation.

- [ ] **Step 5: Verify tests**

Run:

```bash
npx vitest run --root . src/server/update-helper/k3sAssets.test.ts
```

Expected: PASS. If Helm is unavailable locally, state that rendered Helm validation was not run rather than claiming it.

### Task 6: GitHub Actions dependency maintenance

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/docs-pages.yml`
- Modify: `.github/workflows/harness-drift-report.yml`
- Modify: `.github/workflows/labeler.yml`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Updates `actions/setup-node@v6` to `@v7`, `actions/labeler@v6` to `@v7`, and `actions/cache@v5` to `@v6` without changing inputs.

- [ ] **Step 1: Apply exact action-major substitutions**

Do not modify workflow triggers, permissions, or publishing behavior.

- [ ] **Step 2: Verify workflow references**

Run:

```bash
rg -n 'actions/(setup-node@v6|labeler@v6|cache@v5)' .github/workflows
rg -n 'actions/(setup-node@v7|labeler@v7|cache@v6)' .github/workflows
```

Expected: no old references; 15 setup-node v7, one labeler v7, three cache v6 references.

### Task 7: Full verification, repository update, and Docker publication

**Files:**
- All modified files from Tasks 2-6

**Interfaces:**
- Produces tested Git commit(s), updated fork branch/main, and Docker Hub tags.

- [ ] **Step 1: Run complete repository verification**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run repo:drift-check
```

Expected: all exit 0.

- [ ] **Step 2: Verify Docker build locally**

Run:

```bash
docker build -f docker/Dockerfile -t kennethww/metapi:pr-fixes-local .
```

Expected: build exits 0.

- [ ] **Step 3: Smoke-run the built image**

Run with temporary strong tokens and a disposable volume/port. Verify `/` or health endpoint responds, then remove the disposable container.

- [ ] **Step 4: Review diff and commit**

Use focused commit(s) ending with:

```text
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

- [ ] **Step 5: Push the tested branch and fast-forward fork main**

Push the isolated branch, then update `yswlww/metapi:main` only after verifying the intended commit graph.

- [ ] **Step 6: Publish Docker Hub tags**

Publish:

```text
kennethww/metapi:<short-sha>
kennethww/metapi:latest
```

Use the existing repository convention of amd64 publication unless a verified multi-architecture builder is configured.

- [ ] **Step 7: Verify registry state**

Run:

```bash
docker buildx imagetools inspect kennethww/metapi:latest
curl -fsSL 'https://hub.docker.com/v2/repositories/kennethww/metapi/tags/latest/'
```

Expected: registry digest is updated and pullable.

## Self-review

- Spec coverage: all 11 open PRs are classified; valid remaining defects/features are assigned to Tasks 2-6; already-fixed and rejected items are explicit.
- Placeholder scan: no TBD/TODO/implement-later instructions remain.
- Type consistency: pattern sync input/output and header-priority option names are defined once and used consistently.
