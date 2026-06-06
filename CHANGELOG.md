# Changelog

## v0.2.2 — Installable MCP Plugins, Notifications, and AI Gateway exclusivity

This release delivers the full installable-plugins system for MCP servers: a new `@oxagen/plugins` package provides registry catalog sync, per-workspace encrypted credential storage, OAuth PKCE/PKCE-refresh flows, org allow-list/denylist/governance controls, and an in-app marketplace UI with a plugin detail panel and re-auth deep-link page. A new `@oxagen/notifications` package powers in-app alerts — triggered automatically when credentials need re-auth — surfaced through a live `NotificationsBell` component. All plugin and notification surfaces are wired end-to-end: `@oxagen/oxagen` contracts, handlers, API routes, MCP tools, and a comprehensive Playwright E2E suite covering install, uninstall, disable, OAuth connect, denylist enforcement, RBAC negative paths, and live agent tool-call integration. The release also finalises AI Gateway exclusivity (direct provider keys fully removed), hardens the capability registry against bundler/HMR re-registration, and closes several pre-existing lint and type errors.

---

### Features

- **`@oxagen/plugins` package** (`6c979a9`): New monorepo package scaffolding the entire installable-plugins surface.
  - **Registry & catalog sync** (`bcbf6c4`, `014eac2`, `9df350f`, `b889c5b`): MCP registry OpenAPI client with Zod response types; catalog sync service (DI port + system-DB adapter); Inngest cron (`plugin.catalog-sync-cron`) and on-demand `plugin.registry-sync` event; full `plugin.registry.*` and `plugin.catalog.*` capabilities (contracts, handlers, API routes, MCP tools) with parity across all surfaces.
  - **README fetch & render** (`41692e6`): Fetches upstream server READMEs, sanitizes HTML, and rewrites relative image URLs for safe in-app display.
  - **Org governance — allow-list, denylist, and workspace install/enable** (`c35b7b5`, `211b72b`): Capabilities for org-level plugin installation, bulk install, uninstall, enable/disable, and per-workspace enable/disable; denylist add/remove with runtime enforcement.
  - **Per-workspace encrypted credential persistence** (`9bae5f6`, `1fbf249`): KMS resolver + envelope encryption service (SOC2-aligned); `workspace-credential` storage backed by `mcp.credentials` table.
  - **OAuth PKCE/state store** (`960d235`, `1168082`, `32ceeee`, `d81e3c7`, `fad9d48`, `7c24d7d`): DB-backed PKCE/state store; `DbOAuthClientProvider` over `mcp.credentials`; `connectMcp` extended to accept an OAuth auth provider; MCP OAuth `authorize` and `callback` route handlers; `assertMcpManager` role gate applied to all OAuth routes.
  - **OAuth token refresh watcher** (`3a7b652`): Inngest function monitors expiring tokens and marks credentials `needs_reauth`; triggers org-manager notifications automatically.
  - **`plugin.credential.reauth` capability** (`8b9c543`): Allows managers to trigger re-auth for a specific credential.
  - **`plugin.org.list` capability + settings page parity** (`f4574dd`, OXA-1571): Lists all plugins installed at the org level; settings page brought to full capability parity.
  - **`plugin.settings.set_auth_alerts` capability** (`84a1a72`): Org-level toggle for auth-alert notifications.

- **`@oxagen/notifications` package** (`040bc5e`, `d0fc18c`, `e3a78f7`, `fd473e6`): `createNotification` service + types; `notifyOrgManagers` with email mirror and log-and-continue error handling; `markCredentialNeedsReauth` calls `notifyOrgManagers` automatically.

- **Notifications API surface** (`037183d`, `00ec0ea`, `6a95b80`): `notifications.list` and `notifications.mark` contracts, handlers, API routes, and MCP tools, all fully tested.

- **App UI — MCP plugin management** (`fa2dc7b`, `96ca30e`, `d816edf`, `ade2e2b`, `b82b68a`):
  - Org plugins settings page: allow-list, registries, denylist, and custom server forms (`211b72b`).
  - MCP marketplace modal with single and bulk install (`96ca30e`).
  - Plugin detail panel with README rendering and credential surface (`247` lines, `plugin-detail-panel.tsx`).
  - Workspace MCP install/enable and credential surface (`fa2dc7b`).
  - MCP re-auth deep-link page at `integrations/reauth/[listingId]` (`ade2e2b`).
  - `NotificationsBell` wired to real `notifications.list` + mark server actions (`b82b68a`).

- **Agent PluginType spine** (`2504463`, `mcp.ts`): `PluginType` enum + governance-gated MCP contributor; `materializeTools` injects plugins via the registry at runtime.

- **Database migrations** (`3569fc2`, `8e40dfb`): Migration `0008` adds installable-plugins schema (MCP, plugin, and notification tables + bytea helper); migration `0009` adds `agent.mcp_servers.enabled` toggle. Partial notification index, `CHECK` constraints in Drizzle, `_check` naming convention, and idempotent seed addressed in follow-up (`9112e89`).

- **`asset.upload` binary capability** (`fe8f0d1`): Contract, handler, API route, and MCP tool for binary asset upload; deduplicates Stripe routes through `invoke()`.

- **Vercel AI Gateway exclusivity** (`0a067a8`): `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` removed from `.env.example`; `AI_GATEWAY_API_KEY` is now the sole required AI credential.

- **`oxagen_app` non-superuser Postgres role** (`36660d2`, OXA-1552): Three migrations and `provision-rls-role.ts` provisioning script create the required precondition for live RLS enforcement.

- **Docs — plugin capabilities and marketplace** (`8f65cb8`, `43d3c98`): New `docs/capabilities/plugin.*` and `docs/capabilities/notifications.*` reference pages; `apps/docs` MDX pages for marketplace and workspace-plugins.

---

### Fixes

- **MCP plugin bugs** (`088dc4b`): Resolves multiple runtime bugs in MCP plugin integration discovered during development.
- **`setAuthAlertsAction` param type alignment** (`5113fee`): Aligns `string[] roles` param type with the panel prop; enum validation moved to runtime to fix `apps/app` typecheck failure after agent-surface change.
- **Capability registry resilient to HMR re-registration** (`e4a77d9` / `e24c2f5`): Registry now warns and keeps the first registration on duplicate name; build-time duplicate-name gate added — unblocks dev server and E2E runs.
- **`NotificationsBell` `setState`-in-effect lint errors** (`a5ba328`): Fixes React lint violations; OAuth connect/reauth links now point at the real `authorize` route.
- **Auth `rateLimits` schema key** (`e4a77d9`): Corrects a misnamed key in the rate-limits schema that was breaking all production auth.
- **Lint errors across notifications/plugins/handlers/api** (`7ca2c55`): Resolves pre-existing and newly introduced lint errors across the affected packages.
- **`db-migrate` baseline re-stampable** (`b8267ac`): `0000` baseline treated as a re-stampable snapshot; resolves production CI checksum mismatch failures.

---

### Internal

- **E2E test suite — MCP plugins** (`8729a32` through `76541c5`): Mock MCP and OAuth servers with `globalSetup`/`Teardown` wiring; `seedPlugin` DB helper for fixture state; `data-testid` additions across all Plan 6 plugin UI components and the tool-call card; specs covering marketplace install (single + bulk), custom server + registry add, workspace-layer enable, OAuth connect flow, disable, uninstall, denylist enforcement, RBAC negative path, and live agent MCP tool-call integration.
- **`@oxagen/storage` `assets.ts`** (`b2c754e`): Unit tests covering binary upload limits, MIME validation, and key derivation.
- **CI GitHub Actions** bumped from `actions/checkout@v4` / `actions/setup-node@v4` to `v5` across all workflows.
- **Release audit tooling** (`release-audit.md`): Audit report template upgraded to a data-driven renderer with a hero readiness band, score stat-box grid, and per-app/per-package maturity tables; two new audit reports archived under `docs/audits/release-audits/`.
- **Claude settings** (`ca14e54`, settings.json): `defaultMode` set to `bypassPermissions`; worktree config consolidated; status-line cost command added (`b6fb1bd`, `.claude/statusline-command.sh`) showing model, effort level, estimated session cost, and context-window progress bar.

## v0.2.1 — Vercel AI Gateway unification, RLS role precondition, and release-process hardening

This patch release completes the transition to the Vercel AI Gateway as the platform's **sole AI authentication path**: `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` have been removed from the codebase entirely, and `AI_GATEWAY_API_KEY` is now required wherever AI runs. Alongside that, the `oxagen_app` non-superuser Postgres role is introduced as the precondition for enabling live RLS enforcement, the `db-migrate` baseline-stamping bug that broke production CI is fixed, and several release-process and audit gaps from the v0.2.0 release audit are addressed.

---

### Features

- **Vercel AI Gateway — exclusive routing** (`0a067a8`): `@oxagen/ai` now routes 100% of model calls (text, image, embeddings) through the gateway. `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are purged from `.env.example`, all `turbo.json` cache-key declarations (`apps/api`, `apps/app`, `apps/mcp`), and the environment architecture docs. `AI_GATEWAY_API_KEY` is reclassified from optional to required in preview/production.

- **`oxagen_app` non-superuser Postgres role** (`36660d2`, OXA-1552): Three new migrations (`0005_oxagen_app_role.sql`, `0006_oxagen_app_default_privs_for_role.sql`) and a new provisioning script (`tools/scripts/provision-rls-role.ts`) create and configure the `oxagen_app` role. This is the required precondition for `TENANT_RLS_ENFORCEMENT_ENABLED=true` — without a non-superuser connection role, `FORCE RLS` is bypassed by the superuser and the 47 RLS policies are inert in production.

- **AI Gateway fallback + `--from` flag for release notes** (`9f4f641`): `tools/scripts/release.ts` now falls back to the AI Gateway when generating release notes and accepts a `--from` flag to specify the base ref, making the release tooling self-sufficient without direct provider keys.

- **Installable plugins design doc** (`c68529f`): Architecture spec and MCP server registry (`docs/mcp-server-registry.json`, 969 lines) for the upcoming installable-plugins system covering MCP servers, integrations, and content tools.

---

### Fixes

- **`db-migrate` baseline re-stampable** (`b8267ac`): The `0000_*` baseline migration is now treated as a re-stampable snapshot rather than an immutable migration. This resolves the P0 production CI failure where a checksum mismatch between environments caused every `db:migrate` run to fail; `0001+` migrations remain immutable.

- **Turbo cache keys, tenancy coverage gate, PII log redaction** (`3931d35`, PR #28): Three audit findings from the v0.2.0 release audit addressed together:
  - `TENANT_RLS_ENFORCEMENT_ENABLED` and `MCP_PORT` added to turbo cache-key declarations to prevent cache-poisoning.
  - Coverage threshold gate added to `@oxagen/tenancy` (previously ungated, could silently drop to 0%).
  - Email addresses in member-invite log lines (`inviteMemberAction`) are now passed through `maskEmail()` before being written to the logger, preventing PII appearing in structured logs (`packages/handlers/src/logger.ts` exports `maskEmail`; `apps/app/src/app/[orgSlug]/members/actions.ts` updated).

- **Dead `agent.tool_versions` schema removed** (`3931d35` / e2e fixture): Migration `0004_drop_dead_tables.sql` drops `agent.tool_versions` (and other zero-CRUD tables identified in release-audit check #4). The E2E agent-runtime fixture is updated to remove all `tool_versions` inserts/deletes and to join `execution.tool_calls` directly to `agent.tools` rather than through the dropped intermediary table.

- **Image generation empty-state copy** (inline): The `ImagePreview` component no longer references `OPENAI_API_KEY` in its user-visible empty-state message; the text now reads "Image generation is not enabled."

---

### Internal

- **`CLAUDE.md` stale/contradictory claims resolved** (`982742e`, PR #31, release-audit check 20/21): Corrects the `useChat` contradiction (forbidden vs. permitted), removes the deleted label taxonomy (`agent-created`, `foundations`, `application-shell`, `iam`, `SOC2`), retracts the reference to the unshipped `code.*`/`ontology.*` graph query layer, adds four new skill entries (`reablocks`, `reagraph`, `reaviz`, `oxagen-feature`), and appends a **Common commands** cheatsheet and a **Gotchas** section for agent guidance.
- **Release audit report archived**: `docs/audits/release-audits/f981200_20260606T064352Z_release-audit.html` committed, covering 26 checks against `main @ f981200`.
- **`.gitignore`**: `.superpowers/` directory added to ignore list.

## Release Notes — v0.2.0

This release delivers the platform's first complete multi-tenancy security layer (OXA-1515), a substantially hardened Stripe billing stack, a full conversation history experience, workspace model settings, user preferences, org member management, and a new automated CI pipeline for DB migrations and RLS isolation proofs. Test coverage expanded dramatically across every package, and the dead `defineContract` abstraction was removed in favour of the leaner `registerCapability` pattern now enforced across all surfaces.

---

### Features

**Multi-tenancy & Row-Level Security (OXA-1515)**
- Added `@oxagen/tenancy` — a new package providing an AsyncLocalStorage seam (`runInTenantScope`) that propagates `orgId` through the full call stack without prop-drilling (`bf13734`).
- `withTenantDb` and `withSystemDb` wrappers added to `@oxagen/database`; every call site across `agent`, `billing`, `handlers`, `iam`, `ai`, `auth`, `inngest-functions`, `ontology`, `telemetry`, `app`, `api`, and `mcp` has been migrated off raw `db()` / `session()` / `clickhouse()` seams (`1ad20ed`, `f3c3cda`, and ~15 follow-up fix commits).
- Postgres RLS policies generated and applied as migration `0001_rls_policies.sql`; `TENANT_RLS_ENFORCEMENT_ENABLED` env flag controls enforcement per environment.
- `assertRlsConnectionSafe` startup guard ensures the process never runs against a non-RLS-capable connection.
- `scopedSession` tenant seam added to `@oxagen/ontology` so graph memory queries pass through the same `orgId` guard (`b93d05b`).
- `chInsert`/`chSelect` tenant seams added to `@oxagen/telemetry` with `org_id` guard (`9950db3`).
- RLS bypass-aware policy generator and `tenant-policy.manifest.ts` added to `@oxagen/database` for manifest-driven coverage tracking.
- ESLint custom rule (`eslint.tenancy-seams.mjs`) now bans raw seam calls at the lint level; CI enforces it (`a28bb11`).
- Architecture documentation added at `docs/architecture/tenancy-rls/spec.md`.

**CI Pipeline**
- New `rls-integration` CI job spins up a real Postgres, applies the full schema + RLS policies, and runs the isolation proof suite on every PR (`a28bb11`).
- New `migrate` CI job applies Postgres + ClickHouse migrations automatically: preview DB on PRs, production DB on merge to `main`, and a manual `workflow_dispatch` path for catch-up runs (`a28bb11`).
- `db:lint-migrations` (naming + ordinal uniqueness checker) added and wired into the `checks` CI job.
- Coverage thresholds gate added as a separate `test:coverage` turbo task; affected packages must meet ratcheted floors on every PR.

**Conversation History**
- Full conversation history sidebar: list, rename, archive, delete, and purge, with a long-press context menu on mobile (`5a51ff9`).
- Five new API routes (`/v1/.../conversations` list/archive/delete/purge/rename), five new MCP tools, five new handler implementations, and five new `@oxagen/oxagen` contracts — all fully tested (`5a51ff9`, and follow-up parity commits).
- Chat history now persists correctly across turns; new-conversation flow works end-to-end (`ff7caf4`).

**Workspace Model Settings**
- New workspace-level model settings page (`settings/models`) letting workspace admins override default chat, image, and video models and their parameters (`workspace.model.settings.read/write` in handlers, API, and MCP).
- `resolve-model-defaults` and `load-effective-model-defaults` added to `@oxagen/ai` to merge org-level, workspace-level, and system defaults.

**User Preferences**
- New account preferences page (`/account/preferences`) with image/video model defaults (`user.preferences.read/write` in handlers, API, and MCP, `75b54e9`).

**Org Member Management**
- `org.member.remove` and `org.member.role.change` handlers, API routes, and MCP tools added with full IAM-role gating and tests.

**Billing Hardening**
- Auto-reload: configurable threshold + top-up amount, idempotency key on every charge, safety cap to prevent runaway reloads (`autoreload.ts` + tests, `8dce75c`, `b4c4385`).
- Dunning sweep: Inngest cron that retries failed invoices with exponential back-off, cancels subscriptions after max retries, and emits audit events (`dunning.ts` + `billing.dunning-sweep` function).
- Dispute handling: `disputes.ts` implements `charge.dispute.*` Stripe webhook events with evidence submission and automatic refund reconciliation.
- Payment methods: full add / list / set-default / remove surface in `payment-methods.ts`, exposed in the UI via new `PaymentMethods` and `StripeElementsProvider` components.
- Seat proration: accurate mid-cycle proration on seat count changes (`seats-proration.test.ts` — 506-line suite).
- `billing-manage` role now enforced on every mutating billing action (`a403a14`).
- `STRIPE_TAX_ENABLED` env flag added (dark-shipped) for Stripe Tax opt-in.
- Comprehensive Stripe integration reference added at `docs/stripe-integration.html` (`6e7c7e8`).

**Workspace Creation**
- Real workspace-creation flow (OXA-1463): dialog → server action → handler → DB, replacing the stub (`6fd6d5d`).

**Database**
- Migrations re-baselined into a single `0000_baseline.sql` (`19e59fd`); pg_dump 16 `\restrict` meta-commands stripped for compatibility (`e928d70`).
- New migrations: `0001_rls_policies.sql`, `0002_security_events_partitioning.sql`, `0003_soc2_auth_hardening.sql`, soft-delete columns on `content.files` + `content.documents` (0007).
- `security.audit-partition-rollover` Inngest function automatically creates the next quarterly partition for the `security_events` table before rollover.

**UI Components**
- New shared `@oxagen/ui` primitives: `RadioGroup`, `SegmentedControl`, `Slider`, `Switch`.
- `MarkdownMessage` component for rich chat rendering.
- Low-balance banner and dunning banner for billing state.
- `BillingFormat` utility library for consistent credit/currency display.

---

### Fixes

- **MCP session token rejection**: `orgId: ''` was fail-open; now correctly rejected with 401 (`8d45512`).
- **MCP dev server**: `watchOptions.ignore` pattern prevented `xmcp dev` from starting the HTTP server; removed (`3d9f0f3`).
- **ClickHouse cold-start**: `ensureDatabase` now retries on connection errors caused by ClickHouse Cloud auto-pause (`583e78a`).
- **ClickHouse schema**: `execution_logs.step_id` changed to `Nullable(UUID)` to match actual insert patterns (`9f284a9`).
- **DB migrate runner**: `search_path` is now reset before each migration file to prevent schema-pollution across files (`f216464`); the `0000` baseline is now treated as a re-stampable snapshot rather than an immutable migration (`b8267ac`).
- **Auth resolvers**: all identity-resolution queries now use `withSystemDb` (legitimate RLS bypass for pre-scope lookups) (`44f37e8`).
- **Billing webhooks / cron**: all cross-org and system-level seams migrated to `withSystemDb`; prorated grants use `withTenantDb` (`8824034`).
- **Inngest functions**: rollup cron and video-render fallback now use `withSystemDb` (`f404042`).
- **Handlers**: bootstrap, cross-org, and file-serve seams use `withSystemDb`; persist paths use `withSystemDb` (`12ae6f1`).
- **App**: new-workspace bootstrap fix included in the RLS seam sweep (`42169ac`).
- **API bootstrap**: CJS-safe import order for the API Hono bootstrap; `.env.example` regenerated (`072239e`).
- **Google Maps secret**: `NEXT_PUBLIC_GOOGLE_MAPS_API_SECRET` renamed to `GOOGLE_MAPS_URL_SIGNING_SECRET` to prevent Next.js from inadvertently inlining it in the browser bundle.
- **MCP install instructions**: `Authorization` header now included in the claude-code MCP install command (`856a131`).
- **Preferences**: image and video model defaults are now applied and wired into the runtime correctly (`75b54e9`).
- **Turbo / env hygiene**: dead `defineContract` export removed; turbo pipeline `env` keys audited and corrected (`c0dae4d`).

---

### Internal

- `defineContract` / `define-contract.ts` removed (319 lines deleted); all contracts now use `registerCapability` directly (`c0dae4d`).
- `@oxagen/database` integration test suite added: RLS isolation proof (`rls.test.ts`) and manifest coverage suite (`manifest-coverage.test.ts`).
- Test coverage expanded across essentially every package: `@oxagen/billing` gained ~2,500 lines of new tests (autoreload, dunning, disputes, payment-methods, seats-proration, billing-settings, webhooks); `apps/api` gained a full unit-test suite; `apps/app` gained E2E specs for auth, billing banner, chat streaming, conversation delete, conversation list, org-create validation, and workspace add.
- `tools/scripts/release.ts` — automated release script added.
- `tools/scripts/db-lint-migrations.ts` — migration naming and ordinal uniqueness linter added.
- `tools/scripts/gen-rls-migration.ts` — RLS policy migration generator added.
- `tools/scripts/backfill-org-iam.ts` — one-time IAM backfill script added.
- Brand asset files (fonts, SVGs, CSS) removed from the repository; now distributed via `docs/brand/files.zip`.
- Model slug defaults updated: `openai/gpt-image-1`, `bfl/flux-2-max`, `google/veo-3.0-fast-generate-001`, `google/veo-3.0-generate-001`.

