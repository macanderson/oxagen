# Changelog

## What's new in v0.7.0

This is the largest release since v0.6.0, delivering four major capability pillars: durable sandbox sessions with in-sandbox browser automation, agentic GitHub write operations, a completely redesigned CLI with graph sync and rich session telemetry, and a new cross-LLM feature-verification judge. The release also ships a full evaluation framework (ClickHouse-backed, Terminal-Bench + context-eval), per-workspace GitHub credential resolution (ADR-020), an Environments & Secrets vault UI, and a significant test-coverage push that raises the coverage gate to 85%.

---

### Features

#### Durable Sandbox Sessions (`agent.sandbox.*`)
- **New `agent.sandbox.*` capability surface** — start, exec, snapshot, and stop long-lived Modal sandbox sessions that survive across turns (`feat: 5fc8cbe9`, `ad4b9d91`).
- Sandbox sessions are tracked in a new `agent.sandbox_sessions` database table with full RLS policy registration (`0ce662d0`, `3da…`).
- The durable agent image now pre-installs **Playwright** and **`browserctl`** so the browser is ready immediately (`0be7ea6c`).

#### Browser Automation (`browser.*`)
- **Seven new `browser.*` capabilities** — `navigate`, `fill`, `submit`, `click`, `refresh`, `read`, and `screenshot` — drive a real Playwright browser running inside a durable sandbox (`d6b0275b`).
- All surfaces are wired through the API, MCP tool registry, and contract tests (`59b20fe4`).
- Reference documentation added under `docs/capabilities/browser.*` (`2e3fa998`).

#### Cross-LLM Feature Verification (`agent.feature.verify`)
- **New `agent.feature.verify` capability** — a second, different-vendor LLM acts as an independent vision judge, comparing screenshots from the browser automation loop against the original requirement (`ea47a23b`, `3ca39018`).
- The `feature-browser-proof` skill ties sandbox + browser + judge into a single definition-of-done loop; agents must not self-certify visible features without it.

#### Agentic GitHub Write (`agent.repo.edit`, ADR-019)
- **`agent.repo.edit`** — the agent engine can now clone a connected repo, apply edits inside a sandbox, and open a pull request autonomously (`7709271b`, `94560c9e`).
- Five new low-level repo capabilities: `repo.create`, `repo.fork`, `repo.file.put`, `repo.branch.create`, `repo.pr.open` — all shipped with contracts, handlers, and API routes (`94560c9e`).
- **New `@oxagen/github` package** — fetch-based Octokit replacement with installation-token auth, per-workspace credential resolution (ADR-020), and OAuth-connection fallback (`f62c5d69`).
- The `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` env vars are now documented; `.env.example` updated (`2c60fa7c`).
- A new `/github/setup` landing route handles the GitHub App reconfigure redirect (`aabfd26c`); the Setup URL was corrected to `/github/setup` (`0f4c0ffd`).
- **Bug fix:** the GitHub source wizard no longer stalls after install — the Setup-URL leg was dropping the OAuth connection (`fbc24b82`).

#### CLI — Graph Sync, Commands & Telemetry (ADR-016 / ADR-018)
- **`oxagen graph push` / `graph pull` / `graph status` / `graph lineage`** — bidirectional code-graph sync between the CLI daemon and the workspace (ADR-018 slices 1–3: `5d623155`, `a78aea01`, `c8df7d5a`).
- The local code graph is persisted to **DuckDB** and served by the daemon (`8677699f`).
- **`oxagen cost`** — per-session token cost report using a baked-in rate card (`9c9943f0`).
- **Slash commands** (`/verbose`, custom) — structured session telemetry and slash-command expansion (`400e6efe`, `9c9943f0`).
- **`oxagen settings`**, **`oxagen rules`**, **`oxagen mcp`**, **`oxagen agent`** — new top-level commands backed by a unified `settings.json` driver with env, model, permissions, and hook sections (`4281e9c7`, CLI command additions).
- **Cross-vendor model routing** — an OpenAI advisor and an evaluator-chosen worker now operate independently of the primary executor (`708f9730`).
- **MCP client** — the CLI can now connect to MCP servers and expose their tools in the agent loop.
- `oxagen cost` and `/verbose` emit structured pipeline telemetry and a full rate-card breakdown.
- Standalone npm bundle fixed to strip `workspace:*` dependency leaks (`a2bd4b57`); bundle now published from `release.ts`.

#### Evaluation Framework
- **One-command eval runner** (`tools/scripts/run-evals.ts`) with **ClickHouse ingestion** for `eval_runs` and `eval_results` tables (`e23be06e`, `f7fafe85`).
- **Terminal-Bench (Harbor) adapter** — runs the Oxagen CLI as a Terminal-Bench agent; captures token cost post-run (`84f54a01`, `f591efca`).
- **Context-quality eval** (RAGAS / DeepEval bridge) — `oxagen` vs Claude Code on repo-grounded Q&A (`092fd6e3`, `bc09553f`).
- Warm/self-improvement variants for context-eval and terminal-bench (`b08fb2fc`).

#### App & Platform
- **Environments & Secrets vault UI** — workspace settings panel with bulk `.env` paste import (`0639b28f`).
- **In-app agent drawer** — conversations are now persisted across drawer open/close cycles; UI polish (`0a260319`).
- **`plugin.catalog.sync`** REST route and contract test (`728438c2`).
- **`agent.memory.list`** wired end-to-end to Neo4j; the Memories tab now points at live data (`306f0c63`, `c6f5ffc0`).
- New `@oxagen/agent-engine` package — unified agent engine with port adapters for CodeGraph, Memory, and Trace, wired into `agent.repo.edit` (`09f25002`, ADR-019).
- Agent bar is now suppressed in workspace-less shell sections (`1ae961b4`).

---

### Fixes

- **API crash on cold start** — `fileURLToPath` was executing at module scope inside skill handlers, taking the whole API down (`FUNCTION_INVOCATION_FAILED`); now guarded (`34ff931a`).
- **`streamAgentReply`** now forwards `stopWhen` and `onError` hooks correctly (`6bd2c8da`).
- **`agent.memory.list`** end-to-end wiring was broken; fixed and Memories tab pointed at Neo4j (`c6f5ffc0`).
- **GitHub package** — dropped `.js` import extensions so Turbopack can resolve them (`4a6b6316`); switched from Octokit to fetch to unblock the Next.js app build (`3fadbb85`).
- **`engram` barrel** — `run-golden` CLI self-exec guarded so it no longer crashes the CJS API bundle (`0dea2ec1`).
- **Schema `reconcile` surface bug** — pin→reconcile surface mismatch fixed; worker AI-hang guard added; `graph.export` registry gap closed (`95b8e9fd`).
- **Ontology migration** — idempotent Neo4j migration over legacy `KnowledgeNode` duplicate `publicId` values (`4afa3d36`).
- **`agent.sandbox_sessions`** registered in the RLS `POLICY_MANIFEST` (`6a3d3e1b`).
- **CLI test flakes** — welcome-screen timer tests stabilised; dead frame ternary removed; TypeScript TS18048 optional-chaining errors resolved (`83d4545b`, `e0eb1fb6`, `49961db1`).
- **CLI lint gate** — dead `callCount` variable removed from agent package, unblocking the `prefer-const` gate (`74b6c0b1`).
- **`pnpm dev` pre-flight** — ports are now checked before starting the stack so a running instance no longer crashes the dev command (`04d944b7`).
- **GDPR org-export** — authorization and knowledge admin gate corrected (`07db7680`).
- **CI / OOM** — Node heap raised to 8 GB for app build/typecheck to fix cold-build OOM; checks job timeout raised from 20 m → 60 m (`62431335`, `fe62db20`, `a8425e37`).

---

### Internal

- **Coverage gate raised to 85%** lines/statements across all packages; build artifacts excluded from coverage inputs (`7af7e57e`).
- `database` package real unit tests now reach 94% line coverage; gate raised to 85% (`b971b257`).
- Contract unit tests added for graph/ontology/memory-policy capabilities (`9fb992a6`).
- Turbo pipeline: test files excluded from build inputs; `checks` task timeout extended (`fe62db20`).
- Three new ADRs documented: ADR-018 (CLI↔workspace graph sync), ADR-019 (unified agent engine), ADR-020 (per-workspace GitHub write credentials).
- Full CLI end-user guide published under `apps/docs/content/docs/cli/` (installation, account setup, commands, knowledge-graph, quickstart).
- Eval results schema and runbook documented under `docs/cli/`.
- Release-readiness HTML audit report added (`3bbba270`).

## What's New in v0.6.0

This release delivers a major expansion of the Oxagen CLI into a full agentic coding environment, introduces an Environments & Credential Vault system, adds OpenTelemetry distributed tracing, extends the knowledge graph with natural-language semantic search, and ships per-agent git isolation for multi-agent fleet workloads. Dozens of new capability contracts are now surfaced consistently across the API, MCP, agent runtime, and CLI, and CI was stabilized across all of these merges.

---

### Features

#### CLI — Agentic Coding & Fleet Management
- **Local agent loop** (`a2dc7b33`, `6d3e5209`, `079d108c`): The `oxagen` CLI now ships a full context-engine-backed agent loop with a prompt-eval → enhance → completeness-judge pipeline, a model router with fast/balanced/precise tiers, a planner, an evaluator, and a structured trace store. Includes a `/replay` command to re-run a previous trace.
- **Per-agent git isolation** (`a2dc7b33`): Each fleet agent now operates in its own `git worktree` pinned to a specific commit, with automatic merge integration on completion; prevents agents from clobbering each other's working trees.
- **Fleet TUI** (`91dcb7ce`): New `agents` screen shows a live fleet view (`fleet-view`) with per-agent rows, status, and a dispatch-input panel.
- **Competitive analysis doc** (`da1164e6`): Added `docs/CLAUDECODE_GAPS.md` cataloguing Claude Code capability gaps addressed by the Oxagen CLI (`050cddd8`).

#### Code Capabilities (OXA-1352)
- **`code.diff`**, **`code.patch`**, **`code.format`** contracts, handlers, API routes, MCP tools, and CLI commands (`ff487c4f`, `08edd8a4`, `cbb8006e`): Agents and CLI users can now produce unified diffs, apply patches, and auto-format files across multiple languages. Multi-file execution is also supported via `agent.code.execute`.

#### Environments & Credential Vault (OXA-1848/1849/1850)
- **Phase 0 vault** (`c80498c7`, `25a04b96`): New `environments` schema in PostgreSQL (migration `20260626120000_environments_vault.sql`) with full CRUD: `environment.create/get/update/delete/list/set_default`. Secrets are managed through `secret.key.upsert/delete/list`, `secret.value.set/unset`, `secret.reveal`, `secret.export`, and `secret.import_env`. All operations are exposed on API, MCP, and CLI (`apps/cli/src/commands/env.ts`, `apps/cli/src/commands/secret.ts`). A KMS-backed `VaultSecretService` in `packages/plugins/src/vault/` handles envelope encryption; `.env` file parsing (`env-parse.ts`) supports `secret.import_env`. New workspace-environment seed runs on workspace creation.

#### Agent Memory — Auditable Decay & Reinforcement (OXA-1374)
- **Memory decay pass** (`7867c631`): A new Inngest background function (`memory.decay-pass`) implements configurable decay and reinforcement policies stored per workspace (migration `0031_workspace_memory_policy.sql`). New API routes and MCP tools for `agent.memory.policy.read/write` allow operators to inspect and tune retention schedules. The Neo4j memory store gains decay-aware scoring.

#### Knowledge Graph — Unified NL Semantic Search (`050cddd8`)
- **`graph.search`** contract, handler, API route, MCP tool, and CLI command: accepts a natural-language query, embeds it, and returns ranked `GraphNode` results from Neo4j. Generated-file content is now automatically embedded on sync so it is immediately searchable. A new `:GraphNode` Cypher anchor label is emitted on upsert.

#### OpenTelemetry Distributed Tracing (OXA-1544)
- **`packages/telemetry`** gains `tracer.ts` (`ef178d93`): vendor-neutral OTLP HTTP exporter, span helpers, and `packages/telemetry/src/migrations/0015_otel_trace_ids.sql`. Opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`; when unset the SDK stays dormant and all spans are no-ops. `apps/app/instrumentation.ts` wires Next.js into the tracer.

#### Graph — Generated-File Sync Refactor
- `agent.sync-generated-asset-to-graph` renamed and rebuilt as `content.sync-generated-file-to-graph` (`050cddd8`); `record-generated-asset` replaced by `record-generated-file` in `packages/ontology`, aligning the graph model with the broader content ontology.

#### Sandbox Expansion
- Added `workspace.ts` (workspace-scoped sandbox runner), `vercel.ts` (Vercel sandbox adapter), and `modal.ts` stubs to `packages/sandbox`; all with matching test coverage.

#### Capability Manifest & Contracts
- 30+ new capability contracts published in `packages/oxagen/capabilities.manifest.json` covering code, environments, secrets, graph search, and memory policies; all registered in `packages/handlers/src/register.ts` via lazy imports.

#### Documentation
- New `.oxagen/` in-repo agent memory corpus: `ARCHITECTURE_QUICK_REF.md`, `COMMON_GOTCHAS.md`, `INDEX.md`, `MONOREPO_OVERVIEW.md`, `PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md`, `QUICK_CHEAT_SHEET.md`, `USAGE_GUIDE.md`, `README.md`.
- Added `docs/cli/prompts.md` (prompt engineering guide), `docs/specs/github-event-graph-mapping/spec.md`, ADR-017 (OpenTelemetry), and an agentic-coding design doc.

---

### Fixes

- **Worker persist heal/prune** (`0e403c76`, OXA-1865): Reconciled schema-reconcile worker so it correctly persists both heal and prune operations without dropping rows.
- **Schema builder DRAFT property tree** (`da889672`): Fixed the schema builder UI to render a DRAFT node with its full property tree rather than a collapsed stub.
- **Turbopack build & Vercel deploy** (`8f20a106`, `8b35e2c9`): Restored Turbopack for `apps/app`; moved `blake3` and `duckdb` to `optionalDependencies` in `@oxagen/engram` to prevent Turbopack from hard-failing on missing `napi_versions` fields. Falls back to SHA-256 / ClickHouse adapter at runtime.
- **CI: prompt-enhancer `extraQueries`, agent register, MCP parity** (`9737b129`): Resolved missing `extraQueries` field on prompt-enhancer output, agent-register path mismatches, and MCP tool-registry parity failures.
- **CI: green main after OXA-1544/1374/1352 first-pass merges** (`e7438e48`): Corrected import paths, missing env-var declarations for CLI LLM tiers (`OXAGEN_LLM_EVALUATOR`, `OXAGEN_LLM_ADVISOR`), and REPL queue test targeting (`1ac890ae`, `13944f4a`).
- **Vault merge test drift** (`a7378fed`): Repaired affected-only test selection drift introduced by the vault schema merge.

---

### Internal

- Removed three consistently flaky E2E specs (`agent-panel`, `api-key-lifecycle`, `ask-drawer-form-fill`) from CI (`d31ce264`); replaced with focused unit tests for `agent-bottom-bar` and `use-agent-panel-store`.
- `packages/engram`: extracted `hash.ts` with blake3/SHA-256 fallback; added ClickHouse and DuckDB adapter unhandled-error test suites.
- `packages/ontology`: added `labels.ts` with a typed label registry and `schema.cypher` for ontology bootstrap.
- Removed temporary parity scripts `_check-parity-tmp.ts` and `_check-surfaces-tmp.ts`; checks are now part of the gate.
- `tools/scripts/cli-dev.ts` refactored; `backfill-workspace-seeds.ts` added.
- Stale Storybook verification screenshots removed from `docs/verifications/`.

## What's new in Oxagen v0.5.0

This is the largest release since the platform's initial public launch. v0.5.0 lands a full workspace-scoped knowledge schema registry, an interactive CLI with a terminal UI, a floating AI agent panel, first-party GitHub MCP integration, a complete PWA experience, vendor-decoupled durable functions and storage, rich tool I/O rendering in chat, and a sweeping expansion of agent lifecycle and skill management capabilities — alongside dozens of stability, CI, and tenancy fixes.

---

### Features

**Schema Registry (Stream R)**
- Added 22 `schema.*` capability contracts covering label/property/relationship CRUD, versioning, export, validation, reconciliation, and enforcement (`a24042aa`, `9dd84c40`, `ce7308e0`)
- Schema reconcile workers: Inngest `schema.reconcile` function applies registry changes to the live Neo4j graph (`e7379a92`, `509fd6fd`)
- Two-layer Cypher injection guard on all schema mutations (`8b0fdcb6`)
- Deterministic intent layer in the chat agent for reliable AI-driven schema edits — `schema.chat` with drop/property/toggle intents (`a24042aa`, `e46578e5`)
- Schema Registry UI wired end-to-end to the live backend; AI drawer removed from fixtures (`7c6a5c16`, `149a4375`)
- `schema_registry` Postgres schema + ClickHouse DDL migration (`42de67b3`)
- Shared `PinnedSchema` validator + named-constant weights for ingestion conformance (§16.2) (`0ce90512`)

**Ingestion**
- `graph.ingest` capability: text→graph ingestion pipeline with schema-vocabulary enforcement (`68e5c0e4`, `9b74e5a4`)
- Ingested GitHub repository nodes now carry `:KnowledgeNode` and `:Feature` labels (`affb7aca`, `aaead3ae`)
- Per-provider OAuth token refresh for Google, Slack, Zoom, Salesforce, and Microsoft connectors (`91c15c59`)
- `schema.yaml` connector coverage for all major providers; `check:connector-schemas` CI gate added (`e867a01a`)
- Multi-repo GitHub initial sync enabled (`efaaabf9`)
- `graph.ingest` persists web-search and agent run results into the knowledge graph (`f733bfca`, `8d1f543f`)
- Full source deletion now purges orphaned `:Feature` and `:InferredEdge` nodes (`c55ad815`)

**CLI & TUI** (`apps/cli`)
- Interactive TUI with ASCII banner, menu launcher, and argument forms (`3d450ece`, `5ec1448f`)
- `cli:dev` PATH watcher + daemon ADR (`32276fe7`, `ccc195ea`)
- Background daemon with Unix-socket IPC, code-graph builder/watcher, and lifecycle management (`aa66c1e9`)
- `schema` command group exposed in the CLI

**Agent Panel & Chat UI**
- Floating, glassmorphism, draggable AI agent panel replaces the Sheet drawer (`6b3e8f9e`); reverted to stable drawer after regressions, then re-implemented cleanly (`1252abc5`, `a2346715`)
- Tool calls render as typed UI components (never raw JSON) (`f8a31a0c`)
- Live background-task streaming cards in chat (`a9f9a503`)
- Conversation files: downloads fixed, completed tool calls no longer re-execute (`e0038fd8`)
- Chat error toasts deduplicated; turn errors surface as toasts instead of raw JSON inline (`025cef84`, `cfa926e5`)
- `NodeRef` citation with Details popover for pending graph inferences (`9b2d9e4b`, `4289fa07`)
- Message footer with Copy/Save actions and credits display (`1038cb24`)
- Claude-Code-style prompt queue management (`5170c732`)
- Agent-generated assets now persist to the knowledge graph (`26033af8`)

**Marketplace & Plugins**
- Plugin install, list, and enable scoped to workspace; org-level denylist removed (`7c6a5c16`)
- Single-default registry state machine: one default MCP registry per workspace, seeded automatically (`e1a80ba6`, `db17f97d`)
- Live HTTP registry browse/get — synced catalog table and catalog-sync cron removed (`717101b3`, `93c90445`)
- Marketplace modal redesigned with 5 plugin-type tabs (`73bfaf75`)
- First-party GitHub MCP server integration (`d36b116f`)
- `plugin.denylist.*` capabilities retired; `plugin.workspace.set_enabled` added
- Capability-pack `pluginType` field added to manifest schema (`3cb87ace`)
- MCP catalog servers table + `pg_trgm` trigram index migration (`7157aca9`)

**Command Menu**
- Entity search section + LLM suggestions in Command Menu (`00d53005`)
- Prompt-template registry + Quick Actions panel (`f31aaa35`)
- `command.menu.search` and `command.menu.suggest` API routes wired (`306c1ae9`)

**Auth & Security**
- OAuth Proxy for multi-environment social login (`23204aa9`)
- Trusted social sign-in linked to existing account by email (no duplicates) (`2b4718f5`)
- Deterministic `isLocalEnv` check prevents intermittent local 403s (`5ffa16b0`)
- Health gate + boot probe for SMTP transport (`c29c377b`)

**Billing**
- Free→paid upgrade now grants plan credits correctly (Stripe Basil invoice shape) (`e059281e`)
- Auto-reload requires an active subscription (`728cd813`)
- Payment method label surfaced in the billing UI (`728cd813`)
- Billing/member server actions scope env validation so a bad prod var can't wipe the page (`e464db06`)

**PWA**
- Full PWA install prompt + standalone splash screen + route-transition loader (`44a4e2b2`)
- iOS standalone gate for PWA splash (`501a647b`)
- PWA install nudge suppressed on desktop; dismissal is sticky (`38af33a3`)

**Knowledge Graph Explorer**
- Full graph explorer in the Ask/Explore tab with canvas view, table view, toolbar, node/edge detail panels, and create/edit dialogs (`0f29cc2c`)
- Graph stats boxes on the Knowledge → Graph page (`381d9b2e`)
- Inference Details popover; explorer no longer blanks on LLM-inferred placeholder nodes (`1c4a3b17`)

**Agent Lifecycle**
- Product-managed agents visible in the UI as read-only; handler-layer enforcement (`4ad9c40e`, `f0d3ccaa`)
- `agent.definition.*` CRUD, versioning, publish, deploy, and trigger contracts + handlers (`7cd5a104`)
- `agent.subagent.logs` — downloadable per-subagent logfile (`62146541`)
- `agent.subagent.cancel` with CRUD leg and hardened dispatch input validation (`5eba258c`)
- Subagent fan-out viewer with read capabilities and live monitor (`c4e986bd`)
- Agent management UI: list, detail, create, edit, version, deploy, triggers (`6d43f430`)
- Skills, MCP servers, and plugins now discoverable in the agent system prompt; workspace system prompt exposed read-only in Settings (`1c31e4aa`)
- Capability composition engine (`agent.compose`) — plan + execute chains (`ed647bff`)

**Notifications & Email**
- Comprehensive SaaS transactional email templates: verification, invitation, low-balance alert, payment failed, payment receipt (`68dfa9a6`)
- Email failures now observable (`5a50173b`)

**Infrastructure & Vendor Independence**
- Durable functions abstracted via `packages/functions` — Inngest vendor lock-in removed (`23e900a3`)
- Storage driver abstracted; Vercel Blob vendor lock-in removed (`56e42b48`)
- AWS KMS DEK-wrapping adapter + OpenTofu infra scaffold (`b9b87719`)

**Workspace IA & Settings**
- Workspace plugins settings page with registry self-service UI and help popover (`2c3e954b`)
- Tenant-scope seams: `useTenant()` context + `resolveWorkspaceScope()` helper (`d22cb9cf`)
- Workspace settings read/write (`kernel`-routed) (`a3c8c4bf`)
- Org settings read/write (`kernel`-routed) (`89d68d40`)
- Timezone + language surfaces in account preferences and profile (`2d6464bc`)

**`packages/engram`** (new package)
- In-process episodic memory store with DuckDB and ClickHouse adapters, CRDT sync, context compiler, consolidation pipeline, salience scoring, and a Neo4j migration path

**Design System**
- Graphite reskin with updated mesh background, gradient CTAs, and auth polish (`381d9b2e`, `b0f2b46f`)
- Storybook set up for `@oxagen/ui` with stories for every component; launched via `pnpm dev` (`ec5c1cb1`, `4b082638`)
- Space Grotesk variable font bundled; design token layer consolidated

---

### Fixes

**P0 / Critical**
- Kernel: enter tenant scope for unscoped caps with real tenant IDs (P0 regression) (`42749cf5`)
- Billing: grant plan credits on free→paid upgrade was broken (`e059281e`)
- App build: agent-panel files dropped by revert war restored (P0 prod build broken) (`82f01451`)
- RLS tenant-isolation lost in Atlas re-baseline restored (`4a0c2cbd`)
- API cold-start crash + `agent.ui.render` handler crash (`4451057b`)
- `oxagen_app` Postgres grants lost in Atlas baseline rebuild restored (`b46ca3d6`)
- GitHub source connect was dead end-to-end (CORS, payload drift, unwired connector registry, missing crypto key) (`386c2f8b`)
- Research swarm progress bar 404 — poll org/workspace-scoped plural URL (`2ef47757`)
- Subagent fan-out hanging silently instead of failing loudly (`e3fbee0f`)

**Migrations & Database**
- `pg_trgm` extension added to `init-postgres.sql` so the GIN trigram index can be created (`7157aca9`)
- `DuckDBEpisodicStore.ready` awaited in `close()` to prevent unhandled rejections (`7157aca9`)
- Out-of-order backfill migration removed; Atlas `atlas.sum` re-hashed (`64071d01`, `9bc89452`)
- `graph.outbox` / `projection_checkpoints` tables never wired — dropped to unblock main (`4dc4cad8`)
- Stale delete constraint checks fixed (`02380253`)

**Chat & Conversation**
- Conversation file downloads returned 404; completed tool calls re-executed — both fixed (`e0038fd8`)
- Chat agent stopped fabricating `/api/v1/assets/` URLs for agent outputs (`559b827e`, `84214e37`)
- `sr-only` composer labels caused page scroll overflow; contained (`c8ffb7a7`)
- Mobile composer bottom padding fixed (`36a6fea3`, `133b7bcc`)

**MCP & Plugins**
- 13 missing MCP-surfaced tools registered; plugin registry mock outputs fixed (`9ca4b99c`)
- MCP OAuth `authorize`/`callback` route handlers no longer 502 on `notFound()` (`a2b5147f`)
- MCP live endpoint resolved from workspace registries on install (no more empty-endpoint listings) (`c43fb242`)
- `plugin.org.install_bulk` per-type row mapping fixed (`dcd508ee`)
- Workspace plugin install and marketplace detail (`catalog.get` 500) unbroken (`4b3e59fd`)

**Ingestion**
- Pipeline steps 4 & 5 wrapped in `runInTenantScope` (`681f4e8c`)
- `deliveryConfig` owner/repo/defaultBranch populated before firing GitHub ingestion event (`d93f2318`)
- Tree-sitter WASM grammars resolved in local dev (was producing zero code-graph symbols) (`6c1a824d`)
- Source deletion unstuck — wrong column name left sources in `deleting` state forever (`cce1167f`)
- `connection.mappings.set` reconciliation and `repoBase` restored after breakage (`5281fc33`)

**Auth**
- `workspaceMiddleware` now enforces workspace membership (fixes e2e isolation) (`044bfc30`)
- `ontologyPrompt` + `semanticEdgePrompt` persisted in `integration.configure` (`2199f7b7`)
- Research swarm status cross-process 500 fixed (`7babf109`)

**Telemetry**
- Non-UUID strings flooding `token_usage.execution_step_id` stopped (`cd7c9c91`)
- Telemetry sync was silently broken since Jun 9 (stale shell env + tsx cold-boot timeout) (`438d58e1`, `6cc7ac83`)

**CI**
- Inngest function concurrency limits capped at 5 (plan cap); unblocked app sync (`615efe04`)
- `.github/workflows/ci.yml` replaced with `pipeline.yml` to force fresh workflow registration; multiple workflow compile errors fixed (`1ab42fd7`, `2170f3c1`)
- Atlas version pinned; dedicated validate job; pre-commit hook added (`1f93b256`)
- `GITHUB_APP_SLUG` provided to e2e environment (`abd43205`)
- `STORAGE_DRIVER` env registry entry + dynamic skill-seed counts (`8e6926ca`)

---

### Internal

- `packages/engram` — new first-party episodic memory substrate (DuckDB/ClickHouse, CRDT sync, context compiler, consolidation, salience, Neo4j migration) (`aa66c1e9`)
- `packages/functions` — vendor-agnostic durable-function abstraction replacing direct Inngest imports (`23e900a3`)
- `packages/mcp-config` — MCP credential, permission, managed-policy, and server-resolution utilities extracted into dedicated package
- `packages/prompt-templates` — built-in YAML prompt template registry; static data bundle (no `node:fs` in client build) (`f31aaa35`, `628839fb`)
- Biome formatter adopted; `lefthook` pre-push import-graph gate (ADR-015) (`cfab4afa`)
- pnpm bumped to 11; workspace config consolidated (`89d4cc4d`)
- Stale Studio, mock security/incidents pages, and org-level plugin pages deleted (`18c606e2`, `d3772eef`)
- Agent auditor definitions refactored to `eval-*` naming with shared evaluator output protocol
- Per-capability JSON Schema generated and published to `docs/capabilities/schemas/` (`a2aa53e1`)
- `docs/brand/` consolidated with full PWA icon set, social images, and spinner assets
- `docs/specs/inventory/` — comprehensive handler/function/route inventory documents added
- ADR-013 (Oxagen Plugins), ADR-014 (workspace-scoped MCP registry), ADR-015 (Biome/git hooks), ADR-016 (CLI daemon + live code graph) published

## v0.4.0

This release delivers a significant expansion of the Oxagen platform: 20 new capability contracts spanning repo management, integrations, plugin schemas, semantic edges, and graph operations are now fully wired from API routes through MCP tools to CLI commands. A new `/chat/stream` SSE endpoint brings MCP-aware streaming to both the API and the app's chat shell. The ingestion pipeline gains schema-driven connector support (GitHub, Google Drive, Slack, Linear), filter enforcement, sync cadence scheduling, and an Inngest-backed semantic edge inference and approval flow. Across the board, substantial test coverage was added — including a new `packages/web` utility library, 30+ new handler tests, and ratcheted coverage thresholds.

---

### Features

**Capability contracts & parity (Phases 1–6)**

- Defined 20 new contracts across five domains: `repo.*`, `integration.*`, `plugin.schema.*`, `semantic.edge.*`, and `graph.*` enhancements (`e90d9e0d`, `3a39ebcc`)
- Wired all 20 contracts into API routes (`apps/api/src/routes/v1/`), MCP tools (`apps/mcp/src/tools/`), and CLI commands (`apps/cli/src/commands/`) (`5984bc68`, `3a39ebcc`)
- Implemented real handler logic for `plugin.schema.get` and `plugin.schema.validate` (`e5745404`)
- Added `semantic.edge.approve` contract and regenerated the capabilities manifest (`8eb986f8`)
- Added capability docs for all 20 Phase 1 contracts under `docs/capabilities/` (`2d231301`)
- Added connector-authoring and partner-registration guides under `docs/guides/` (`6464d6ee`)

**Chat streaming**

- Added `/chat/stream` SSE endpoint (`apps/api/src/routes/v1/chat.stream.ts`) with full MCP server support and token streaming (`52589f82`)
- Wired the Next.js proxy route at `apps/app/src/app/api/v1/chat/stream/route.ts`
- Added per-turn MCP server activation picker (`mcp-server-picker.tsx`) end-to-end, including `activeServerIds` forwarding in `ChatShellClient` (`8a557987`)
- Added conversation page (`apps/app/src/app/[workspaceSlug]/_shared/conversation-page.tsx`) and chat shell client component

**Ingestion pipeline**

- Phase 3: dynamic schema-driven form renderer for connectors (`5e905dd6`); new components: `ConnectorConfigForm`, `ConnectorSchemaProvider`, `FieldRenderer`, `FiltersPanel`, `SyncCadencePanel`, `InferencePanel`, `AuthSchemePicker`, `SecretFileUpload`, `RecordTypeSelector`, `KeyValueEditor`
- Phase 4: filter enforcement and sync cadence scheduling (`ceda260d`); new `packages/ingestion/src/filters.ts` and `pipeline.filter.ts`
- Phase 5: semantic edge inference + approval flow via Inngest (`ingestion.semantic-edge-infer`, `ingestion.sync-requested`) (`0c0a4950`, `15f3f4d0`)
- Phase 6: partner plugin schema support; YAML schemas added for GitHub, Google Drive, Slack, Linear, and an example SaaS connector (`6464d6ee`)
- Added `connector_schemas` DB table and migration `0030_connector_schemas.sql` (`777809f9`)
- New `packages/ingestion/src/connector-schema-loader.ts` for loading and caching YAML schemas

**Semantic edge UI**

- Added `InferenceApprovalModal`, `InferencePendingList`, and `SemanticEdgeViewer` components under `apps/app/src/components/knowledge/graph/`

**New `packages/web` library**

- Introduced `packages/web` with `fetch.ts` and `search.ts` (Tavily-backed web search); `TAVILY_API_KEY` added to `.env.example`

**Branding & design tokens**

- Added Oxagen CSS design tokens (`packages/ui/src/styles/oxagen-tokens.css`) and gradient-border utility styles (`15f396a9`)

**Agent tooling**

- Added `ci-green` skill (`.agents/skills/ci-green.md`) — standardized CI gate workflow before any push (`add ci-green skill`)
- Added `test-completeness-judge` skill (`.agents/skills/test-completeness-judge.md`) — gates PR opening on unit + E2E coverage proof
- Added `PostToolUse` hooks for auto-lint-fix, typecheck, and session telemetry recording

**CLI**

- Added CLI commands: `graph.cypher`, `graph.edge.upsert/delete`, `graph.node.upsert/get/delete/search`, `research.swarm.start/status`, `web.fetch`, `web.search` (`apps/cli/src/commands/`)
- Fixed `chat send` command to route through the new SSE stream endpoint (`52589f82`)
- Added comprehensive CLI environment variable precedence tests (`63ef64f3`)

---

### Fixes

- Replaced all bare `<img>` tags with Next.js `<Image>` component; renamed `Image` icon import from lucide to `ImageIcon` to avoid conflict (`64ba6e26`, `0d3e16c1`, `9377f899`)
- Fixed route-contract parity for hyphenated-plural routes (`ac004ceb`)
- Skipped Phase 5–6 stub contracts in the parity test until routes are fully wired (`e3cb76b0`)
- Fixed `SourceConnectionRow` cast in Inngest functions using double assertion (`12e4415f`)
- Wired 18 missing tools into the MCP tool-registry parity test (`7357db8c`)
- Added missing dependencies (`@oxagen/crypto`, `hono`, `ai`, `@modelcontextprotocol/sdk`) to `packages/handlers` (`733d9145`)
- Removed pnpm-specific settings from `.npmrc` to eliminate npm warnings; moved them to new `.pnpmrc` (`e7bbdc04`)
- Fixed bootstrap test hoisting conflict and module state persistence (`1a63b5bc`)
- Added missing `edgesCreated` field to `agent.memory.write` test mock (`f9b439a4`)
- Registered `research.swarm` tools in MCP tool registry test (`767c73a5`)
- Regenerated lockfile with updated dependencies (`e1000d50`, `533e886e`, `aa5b92b5`)

---

### Internal

- Removed stale `docs/reference/application-shell-spec/` reference app (entire directory deleted)
- Removed artifact files (`errors.txt`, `test_output.json`) from tracking; added both to `.gitignore` (`2c17d2ae`)
- Removed `.devtools/generations.json` from tracking; added `.devtools` metadata to `.gitignore` (`27dd2e94`)
- Added `tools/scripts/claude-session-summary.ts` for ClickHouse telemetry; added logging to CC telemetry (`0b73c945`)
- Added analytics env vars (`ANALYTICS_USER`, `ANALYTICS_PASSWORD`, `ANALYTICS_URL`, `ANALYTICS_DATABASE`) to `.env.example`
- Added CLI env vars (`OXAGEN_API_TOKEN`, `OXAGEN_ORG_ID`, `OXAGEN_WORKSPACE_ID`) to `.env.example`
- Ratcheted test coverage thresholds for `apps/app` (53/84/71/53) and `apps/mcp` after new suites (`b5e53e95`, `1a5f1ba0`)
- Added 1,551-line `MessageComposer` test suite (98%/84%/90% coverage), 410-line `McpServerPicker` suite (100%), and 465-line `marketplace-modal` suite (96%/93%/93%) (`c23c419e`, `1a5f1ba0`, `ca8fc7d3`)
- Renamed `regression-test-judge` skill to `test-completeness-judge`; expanded scope to gate all PRs (`d9839304`)
- Reduced `CLAUDE.md` by ~45% while preserving all rules (`65851b2b`)
- Integrated verification, CI, and DB migration guidance into `CLAUDE.md` (`062da63d`)

## What's Changed in v0.3.3

No changes were provided for this release. The commit log, diffstat, and diff are all empty, so no user-facing release notes can be accurately produced.

> **Note for maintainers:** If you intended to document changes since v0.3.2, please re-run the release notes generation with the relevant commit log and diff included. Fabricating changelog entries has been intentionally avoided here.

## What's Changed in v0.3.2

No commit history or diff was provided, so there are no documented changes to summarize for this release.

---

> **Note for release managers:** Please re-run this request with the actual commit log, diffstat, and/or unified diff included so that accurate, evidence-based release notes can be generated. Inventing changes without supporting source material would be misleading to users.

## v0.3.1 — Ingestion pipeline, GDPR privacy layer, agent sub-capabilities, and a major test-suite hardening pass

This release delivers four major areas of new functionality on top of v0.3.0: a full multi-connector data ingestion pipeline (GitHub, Google, Slack, Linear, Salesforce, Microsoft, Zoom, and custom sources) backed by a Neo4j/Postgres dual-write architecture; GDPR Art. 17/20 right-to-erasure and data-export contracts wired end-to-end through handlers, API, MCP, CLI, and a new docs page; four new agent sub-capabilities (`agent.subagent.dispatch`, `agent.subagent.aggregate`, `agent.skill.load`, `agent.code.execute`) promoted from stub to fully implemented; and a sweeping test-suite hardening effort that eliminated brittle mocks, raised coverage across nearly every package, and enforced per-package thresholds as ratchets in CI.

---

### Features

**Ingestion pipeline (`@oxagen/ingestion`, `@oxagen/inngest-functions`, `@oxagen/database`)**

- New `@oxagen/ingestion` package with a complete connector registry: GitHub (OAuth + App, tree-sitter source-code parser), Google (Drive, Gmail, Calendar, Meet, Contacts, Tasks, BigQuery), Slack, Linear, Salesforce, Microsoft (Graph), Zoom, and custom-SQL/webhook stubs (`e34b352f`, `c28a1bb0`, `baad3528`).
- Ingestion pipeline (`pipeline.ts`) with deduplication scoring, entity-type inference, Neo4j upsert mutations, and an embed renderer (`2729c185`, `baad3528`).
- GitHub App OAuth callback and connection-setup endpoints (`a3df6b67`); GitHub sync Inngest functions for initial sync, file parsing, and feature inference (`c28a1bb0`).
- `IngestionEntityReceived` event type and integration tests (`f88fceda`).
- New `connection.*` contract suite — `connection.create`, `.delete`, `.get`, `.list`, `.preview`, `.mappings.get`, `.mappings.set`, `.mappings.suggest` — wired through handlers, API route (`apps/api/src/routes/v1/connection.ts`), and eight MCP tools (`d371c5ec`, `962b62ac`).
- Ingestion database schema migrations 0001–0004 (core tables, ontology, deletion jobs, OAuth accounts) plus RLS migration 0029 (`804f0372`, `cd70875d`).
- AWS KMS stub and ingestion crypto factory in `@oxagen/crypto`; `INGESTION_CRYPTO_PROVIDER`, `INGESTION_ENCRYPTION_KEY`, `AWS_KMS_INGESTION_KEY_ARN` added to ENV registry and `.env.example` (`1e4d72a0`, `90cf508a`).
- Inngest functions for OAuth token refresh, connection deletion, and the full ingestion pipeline (`6a8a1681`); Claude Code telemetry pipeline piped to ClickHouse production (`e555454e`).
- ADR-012 documenting the connector dual-write pattern (Postgres durability + Neo4j index) (`7f44cf7a`).

**GDPR privacy layer**

- `privacy.data.erase` (Art. 17) and `privacy.data.export` (Art. 20) contracts, handlers, Inngest processing functions, API routes, MCP tools, and CLI commands (`privacy.erase`, `privacy.export`) (`90269312`, `c99f4d03`).
- Org-level and account-level privacy settings panels in the web app.
- New `PRIVACY_ERASURE_GRACE_DAYS` env var (default `0` for test envs).
- `privacy.data.erase` / `privacy.data.export` docs pages under `apps/docs` and `docs/capabilities/` (`90269312`).
- Database migration 0008 for GDPR tables; migration 0009 adds RLS and agent-plans upgrade.

**Agent sub-capabilities**

- `agent.subagent.dispatch` — fans out sub-tasks with configurable parallelism, returns per-branch run IDs (`0d0912c2`).
- `agent.subagent.aggregate` — collects and merges results when all dispatched branches settle (`67b5e46d`).
- `agent.skill.load` — dependency-resolving skill loader (`97f52b2c`).
- `agent.code.execute` — sandbox runner wired to `@oxagen/sandbox` (`a94dc10e`).
- All four capabilities wired through contracts, handlers, API routes, and MCP tools.

**AI platform**

- Anthropic prompt caching enabled; cached tokens metered correctly in ClickHouse (`81cb6b04`).
- Auto-improve prompts (Beta): LLM judge enhances insufficient prompts before execution (`af84bf80`).
- Prompt registry and `prompt.settings` capability (org + workspace scoped, IAM-gated) (`719c038f`).
- `chat.message.execution` route added to close API ↔ MCP parity gap (`3feacdd1`).
- `recordExecution()` and `chat.message.execution` handlers implemented (`d395f5ab`).

**Database**

- Migrations 0005 (agent plans table), 0006 (security events + checkout/privacy types), 0007 (agent execution tables), 0010 (billing plans seed), 0028 (documents/forms/automations/prefs), 0032 (agent execution RLS standard policy).
- Dynamic `EntityNode` model replaces hardcoded entity types in the ontology (`541d6d10`).
- `ingestion` added to the `Surface` union in `@oxagen/telemetry` (`e168b7ef`).

**Web app / UI**

- GitHub connection wizard and knowledge-sources client component in the app (`apps/app/src/components/knowledge/`).
- Plugin marketplace now filters by `pluginType` (`b7c10062`); MCP server install UI fixed (`b9fd3dd4`, `c517e4d0`).
- `Select` controlled/uncontrolled fix and combobox search filtering fix (`1638da80`).
- Ask drawer wired to real wand actions; conversation-wipe reconcile bug fixed (`9cb67ed9`).
- Spinner animation fixed; wand button hidden on `/ask` page (`e3c949dc`).
- Documentation home page navigation cards added and made visible without scrolling (`cceab5c6`, `7262bc29`).

**CLI**

- `privacy.erase` and `privacy.export` commands added.
- `agent.plan.create` command added.
- TTY-gate on PII email emissions in `auth.login` and `workspace.member.list` (`c99f4d03`).
- `MCP_URL` added to ENV registry; `.env.example` regenerated (`61253be1`, `90cf508a`).

---

### Fixes

- **E2E:** Corrected Playwright route-mock patterns for connections tests; raised Postgres `max_connections` in dev compose (`75706c6d`); removed unconditional skips from `mobile-nav.spec.ts` (`1047f70f`); resolved 9 CI failures across auth seed, API server, signup redirect, and nav interrupt (`62dee9de`); fixed `loginAs` to pass email + password instead of session token (`517a5583`); removed `waitForTimeout` calls and stub spec, added real assertions, fixed localhost URLs (`60a46799`).
- **Database:** Replaced failed agent-execution RLS migration with a correct table-creation migration (`cd333abf`); removed dead `grants`/`policies` schema refs and replaced with `principalRoleAssignments` (`111b62d6`, `8af89c87`); fixed agent-plans RLS upgrade migration (`407aab0d`); added `billing.checkout_initiated` to the security event type snapshot (`8430846b`).
- **API:** Added missing `@oxagen/crypto` and `@oxagen/ingestion` deps for the webhook route (`2d55c4d3`); fixed lint warnings and added webhook route tests for green CI (`12e6a966`).
- **MCP:** Registered 8 `connection.*` + 2 `privacy.*` tools in the xmcp tool registry (`962b62ac`).
- **IAM / Inngest:** Removed dead schema grant/policy refs; fixed `execute<T>` type constraint; fixed ingestion `RowList` usage (`b857ef5b`); emitted `auth.sign_out` events for TTL-expired sessions (`73205298`).
- **Billing:** Added `emitSecurityEvent` audit trail to billing checkout handlers (`3ebcf1b4`).
- **Auth:** Removed unused `customType` import from auth schema (`9c05be54`); fixed `assertWorkspaceMember` and workflows-page calls to use `runInTenantScope` (`319d1d0d`, `b65786a6`); used `withSystemDb` in `resolveOrgTier` for cross-tenant scope resolution (`cc8e81c7`).
- **CLI:** Resolved lint errors (any types, unused vars) (`2ad44845`).
- **Config:** Turbo cache hygiene; scanner-safe `.env.example` placeholders; accurate trust-page infra copy (`ec9530f6`).
- **Misc type fixes:** Narrowed `originType` contract and added audit trail to tool calls (`e95cb4df`); fixed zero-coercion and missing foreign keys in execution schema (`2c4ad501`); preserved transaction atomicity in `chat.message.execution` handler (`ffbf2a8c`); typed `MediaTier`, `Surface`, and `mode` enums in Inngest functions (`1b522a0a`).

---

### Internal

- **Test hardening (broad):** Removed brittle `vi.mock("drizzle-orm")` stubs from 84 test files (`1b486dcc`); replaced `lucide-react` Proxy mock with `vi.fn` stubs (`7e69d49d`); replaced unsafe `as unknown as` casts with typed `vi.Mocked<>` helpers (OXA-1628, `00357dbc`); applied `importOriginal` spread to billing/telemetry mocks (OXA-1627, `05179f9c`); lifted mutable test state into `beforeEach` (OXA-1625, `29451b91`); added `clearMocks: true` and coverage thresholds to all Vitest configs (OXA-1626/1631, `a11bcfe6`); removed fake coverage test, added `coverage.include` to database config (OXA-1623/1624, `b39d4b69`); moved billing tests to colocated `src/*.test.ts` (OXA-1629, `bd0796b5`); added error-path tests to handler unit tests (OXA-1630, `6bc06a76`).
- **Coverage increases:** `@oxagen/sandbox` 43 % → 98 % (`c010ca90`); `@oxagen/telemetry` 51 % → 71 %, 100 % on clickhouse/client/index/security/tenant modules (`e2ed39b2`); `@oxagen/crypto` full coverage for ingestion, AWS KMS, local, and envelope paths, thresholds bumped to 99/97/90 (`cfee540d`); 151 new unit tests for ingestion connectors, pipeline, dedup scoring, and embed rendering (`925be2dd`).
- **New E2E specs:** `api-key-lifecycle.spec.ts`, `workspace-isolation.spec.ts`, `billing-credits-purchase.spec.ts`, `connections.spec.ts`, `plugin-marketplace-install.spec.ts` (`8dce385b`, `e726d9fa`).
- Capabilities manifest updated; 18 capabilities gained implementations (`7711d610`, `82440310`).
- `db-lint-migrations.ts` script updated; `transform-db-mocks.ts` tooling script added.
- `run-all-tests.sh` helper script added to the repo root.
- Claude Code telemetry hook and ClickHouse analytics config added under `tools/scripts/` (`e555454e`).

## Oxagen Platform v0.3.0

This release represents the most substantial expansion of the Oxagen platform since launch, spanning a full CLI buildout, broad API/MCP parity work, agent execution telemetry, workflow infrastructure, improved security hardening, a major UI overhaul, and a significant test coverage push. Dead code and orphaned schemas were aggressively pruned throughout.

### Features

**CLI — full parity buildout**
The `apps/cli` package grew from a minimal dev utility into a production-ready CLI. Over 80 commands were added across auth, billing, agents, workflows, conversations, documents, images, plugins, org/workspace management, and more (9818a9a, f43e524, cd5f98e, 197458c, 2480cae, 7e8d546, 3d8c410). Commands include `auth.login/logout/whoami`, `billing.credits.purchase`, `workflow.run/status/cancel`, `agent.approval.resolve`, `documents.pdf.create`, `form.fill`, and many others. A typed `api-client` module and `config` module back all commands (a48df44), and API key secrets are now redacted in non-TTY output for CI safety (6ddf71c).

**Agent execution recording and telemetry**
A unified agent execution telemetry system was introduced (3c85a20). New database tables track agent executions end-to-end (d6f0aff, migration `0030_agent_execution_tables.sql`). Handlers for recording execution events were implemented (bf70b61), and an Inngest function (`agent.sync-execution-to-graph`) mirrors executions asynchronously to the Neo4j knowledge graph (ee4a62d). A workflow supervisor and per-task executor were also added as Inngest functions (PR #36, #35).

**Workflow UI**
A workflows list page with a `workflow-progress` UI component and sidebar navigation was added to the app (a3df4d6, 063b52e). New contracts for `workflow.run`, `workflow.status`, and `workflow.cancel` are wired across the API, MCP, CLI, and handlers layers.

**Prompt settings UI**
A new `/settings/prompts` page provides per-workspace prompt configuration: an auto-improve toggle, additional instructions field, and enterprise-level overrides (dfc8a15). Corresponding `prompt.settings.read` and `prompt.settings.write` contracts, handlers, and MCP/API routes are fully wired.

**Security — audit event system**
A new `@oxagen/compliance` package centralizes security event type definitions and a `emitSecurityEvent` registry (3885be8). Security audit events are now emitted on `organization.create`, `workspace.create`, provider-initiated subscription cancellations, and credit grants (77e9c51, 414381b).

**Sandbox — Modal runner**
The Modal sandbox runner was upgraded to the Modal 1.4.3 API and wired as the active sandbox driver (e98b007, 622f294).

**App UI — high-fidelity pages**
Numerous app pages that previously redirected or were stubs were replaced with high-fidelity static UI mocks: SSO, SCIM, MFA, Compliance, Incidents, Trust (security section); webhooks, developer docs, MCP install tabs with Shiki syntax highlighting; org plugins; workspace knowledge/activity/settings; and a searchable `Combobox` component for long option lists (cdd97c2, dcd97c2, ba88c67, 1b69eaf, 600bfc3, 1b099b3).

**Auth — forgot/reset password flow**
A complete forgot-password and reset-password flow was shipped with server actions, form components, and e2e specs (193dab7, reset-password.spec.ts, set-password.spec.ts).

**AI SDK devtools**
The AI SDK devtools middleware is now enabled on localhost for easier local debugging (fbe3698). OpenAI reasoning summary streaming via `reasoningSummary:detailed` was also enabled (80e3799).

**RLS — workspace and plugin tables**
Row-level security policies were added for `workspace.workspaces` and all installable-plugin tables (805dfe5, dc60f26). `TENANT_RLS_ENFORCEMENT_ENABLED` now defaults to `true` in `.env.example` and the config registry (e240baf, 9512530).

**New contracts and API/MCP routes (parity)**
Contracts, handlers, API routes, and MCP tools were added for: `api.key.create/revoke`, `archive.create`, `automation.create/list/trigger`, `conversation.chat/purge/rename`, `document.create/list/read`, `form.create/submit`, `image.analyze/create/list`, `workspace.invite.send`, `workspace.member.list`, `skill.workspace.list`, and `agent.execution.record`. The `agent.ui.render` contract was also added and exported (e8d91dc).

**Batch billing operations and auth refactor**
The auth layer was refactored and billing handlers were extended with batch operations (PR #37, 3aba46d). Billing's `grantFreeCredits` was moved to use `withSystemDb` with proper RLS scoping, and a P0 bug granting upgrade credits under an incorrect RLS scope was fixed (2ff39a4).

**E2E test infrastructure**
Playwright e2e specs were added for organization slug changes, workspace slug changes, workflows, reset/set-password, and agent runtime flows (c09cfb3, organization-slug-change.spec.ts, workspace-slug-change.spec.ts, workflows.spec.ts). A four-shard e2e CI job was added to `ci.yml` with proper Playwright browser installation (6380f14, 999edbb).

**Documentation expansion**
The `apps/docs` site gained new content sections for Agent capabilities, API reference, MCP, Governance (RBAC, BYOK, plugins), Enterprise, and Security (SOC 2, audit logging, tenant isolation, code execution, data handling). Architecture specs for agent execution design and workflow runs were added to `docs/architecture/`.

### Fixes

- **Billing P0 — plan upgrade credits not granted** due to RLS scoping bug (2ff39a4)
- **Billing P0 — ClickHouse usage data** `DateTime64(3)` format bug causing bad usage reads (c025865)
- **Auto-reload guard** — prevent enabling auto-reload without a payment method on file (151b850)
- **PlanTier type errors** — resolved circular type reference and multiple type inference failures across the billing subscription stack (b3d2d58, cf35563, 492e99b, a3e2a07, da0a450)
- **Conversation persistence** — fixed new-conversation behavior and persistence across navigation (49195e5)
- **React key deduplication** in `MessageBubble`; new conversations now auto-titled via Claude Haiku (f167a4f)
- **Chat stream** — `materializeTools` now runs inside `runInTenantScope` (8cd7619)
- **Approval SSE event** emitted before blocking on `waitForApproval` (aaa3f09)
- **Audit filter bar** — eliminated `setState`-in-effect pattern (3d5f4f7)
- **`public_id` collision** and schema configuration in database (f8d9c02)
- **Empty text blocks error** and public blob store fallback (5a9f2e1)
- **Auth** — disabled `cookieCache` to prevent RSC cookie-write error (9c9825c)
- **Notifications** — replaced `withSystemDb` with `withTenantDb` and added `orgId` filter (1d6136f)
- **User preferences handlers** — corrected to use `withSystemDb`, not `withTenantDb` (373ee64)
- **Billing actions** — all billing server actions now use proper tenant scope; plan cards have a fallback state (40ad2a1)
- **Kernel HMR** — handler registration is now idempotent under dev hot-reload re-evaluation (9032de2)
- **Inngest client** — lazy-initialized to prevent build-time env crash (73ee740)
- **Database migration 0014** — added missing `workflow_runs` CREATE TABLE migration (d88f543)
- **Schema: `workflowRunTasks`** — restored accidentally dropped table; fixed `workflowRuns.workflowId` nullable (e732ec1)
- **RLS manifest** — added `org_security_policy` and workflow run tables (2f96044, 8c7c3a8)
- **`credit_ledger` reason constraint** — updated to include all valid reason types (505f308)
- **`agent_version_id`** — removed dead column from conversations and all downstream dead code (e34f9fd)
- **`STRIPE_TAX_ENABLED`** added to build env overrides (7abe4ac)
- **Plugin MCP notification RLS** migration applied (migration `0010`)
- **`PageTabs` edge fades** — now gated on actual overflow (0443ee1)
- Various `PlanTier`, ESLint, and TypeScript errors resolved across CI (a4848ab, a8b9059, c6a439d, 5d83396)

### Internal

- **Dead schemas and tables removed** — dropped `event`, `execution`, `integration`, `iam_sessions`, `workspace.folders`, `content.files`, `agent.plan_steps`, and several orphaned agent execution tables from the schema, migrations, and all references (82c692c, 11ac4d3, 895af5d, 541916c, 05cd14b, chore commits)
- **`apps/admin` and `apps/website` removed** — both stub/empty apps deleted from the monorepo
- **`file.serve` route and handler removed** — dead endpoint deleted from API and handlers (11ac4d3, a3515a8)
- **`agent.code.execute`, `agent.plan.create`, `agent.skill.load`, `agent.subagent.aggregate/dispatch` contracts and handlers removed** — 6 dead contracts with no live callers cleaned up (a5e8f21, ea0b7e5)
- **Migrations consolidated** — `drizzle/0000_baseline.sql` captures the full schema baseline; migration archive directory established (34e7619)
- **`pnpm/action-setup` upgraded** from v4 to v5 across all CI workflows for Node 20 runner compatibility (9de0dbb, 33c8205)
- **Coverage** — jsdom + Testing Library infrastructure added to `apps/app`; hundreds of unit tests added across app components, billing, handlers, MCP tools, ontology, auth, and CLI (736cbaf, and numerous test commits)
- **`@oxagen/compliance` package** introduced for security event type registry (new package)
- **Database doc generation scripts** added (`generate-db-docs.js`, `generate-db-docs-enhanced.js`)
- **Audit command tooling** — new Claude commands for `/audit-e2e`, `/audit-security`, `/audit-soc2`, `/audit-tenancy`, `/audit-tests`, and `/remove-deadcode` added to `.claude/commands/`
- **Nightly e2e** CI job now files a Linear ticket automatically on failure (nightly.yml)
- **`AUDIT_EXPORT_SIGNING_SECRET`** and `OXAGEN_API_URL` registered in the ENV registry; `.env.example` regenerated (cbd8d60, c675077)
- **GitHub OAuth env vars** split into `GITHUB_LOGIN_*` and `GITHUB_DATA_*` variants in `.env.example`
- **`APP_URL`** declared in config schema and promoted to a tracked env var (f82c8b3)
- Capability docs index rebuilt; 5 stale orphan capability docs removed, 20+ new capability specs added

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

