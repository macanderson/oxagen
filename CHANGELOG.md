# Changelog

## v2.1.1

This release delivers the full **Chat UX v2** rollout — a unified session-state model, a redesigned mobile and desktop chat shell, agent/session pickers, live cost estimation, wallet/budget gating, and multimodal attachments — alongside a repair of the previously-broken skill detail surface, a workspace-governance and hot-path performance pass across the chat and billing surfaces, a documentation overhaul (README/AGENTS/CLAUDE, plus new docs content for automations, billing, knowledge graph, and environments), and a long tail of stability fixes for billing, database schema drift, and CI/e2e flakiness.

### Features

- **Chat UX v2, end to end (7/7 phases)**: unified session state (#1034, #1036), mobile chat shell (#1037, #1038), session drawer with wallet balance (#1039), desktop Session rail + three-control composer (#1040), agent picker with empty-state suggestions (#1041), live cost estimate + budget-cap pause card + wallet gate (#1042), and multimodal attach (mobile tray, desktop popover) (#1043). Follow-on polish quieted the new-conversation empty state and made context selection happen once per conversation rather than per turn (#1046), let the conversation fill the viewport by dropping width caps (#1047), and reclaimed mobile layout space with a single dismissable LLM suggestion, compact credits, and inferred media (#1044). Rolled out behind the `NEXT_PUBLIC_CHAT_UX_V2` flag.
- **Skills detail surface repaired**: fixed the never-working skill detail page, adding version lineage, checksums, and a draft-then-pin workflow (#1050, `cf7067988`).
- **Repo branch listing**: new `repo.branch.list` capability with contract, API route, and MCP tool for listing branches on a connected GitHub repository.
- **Docs content**: filled major content gaps for automations, billing, knowledge graph, and environments/secrets (#1045).

### Fixes

- **Quality/governance pass** (#1049): closed budget-governance parity gaps, added chat ingress content caps, and fixed hot-path performance and dedup issues across the chat and billing surfaces.
- **Billing**: fixed a production build blocker from a missing `numeric` import in the billing schema (`df3a7406d`) with regression smoke tests (`15ca79a37`); exempted automations-list reads from the billing admission gate (#1030).
- **App**: workspace skill references now resolve by slug instead of public ID (#1033); moved a `Date.now()` call out of `MemoriesPanel`'s render body to satisfy React purity rules (`55259ce1e`).
- **Database**: removed stale Drizzle definitions for already-dropped tables and columns (#1029).
- **CI / e2e stability**: closed three UI-parity gaps blocking the `checks` job on `main` (`5df8e9d0f`); fixed local gate flakiness from env leakage, tight real-timer margins, tenant slug collisions, and invalid workflow YAML (#1032); fixed the `parent-route-redirects` e2e wait primitive and a `provider-model-picker` typecheck issue (`b9cdc869f`, `cd20e0006`); resolved an `access-review` e2e slug collision and a missing audit column on `catalog_servers` (`fae67044e`); re-triggered CI after a dropped `synchronize` event (`fc2e311b3`).
- **Config**: regenerated `.env.example` from the env registry (`3d1ed48af`).
- **Docs**: corrected the CLI splash `stop()` docstring — the cursor is never hidden (#1031, #1035).

### Internal

- Tightened README, AGENTS.md, and CLAUDE.md — removed marketing framing, kept facts (#1048).
- Documented gate gotchas, test parallelism guidance, migration targeting, and release script flags in `AGENTS.md`.
- Unified Evals workspace continued to harden: rewritten e2e write-path spec for the page-based flow, dataset-detail test fixes, and biome/a11y formatting cleanup.
- Added billing schema smoke tests as a regression guard for the numeric-import fix.

## v2.1.0

This release ships the first phase of the **Chat UX v2** overhaul — a unified session-state model and a dedicated mobile chat shell — alongside a redesigned Evals workspace (unified home + dataset detail pages, run history, provider/model picker), a new repo branch-listing capability, and a batch of stability fixes across billing, CI, and end-to-end tests.

### Features

- **Chat UX v2 — unified session state & mobile shell** (#1034, #1036, #1037): introduces a single `ChatSessionProvider`/session store as the source of truth for agent, repo, model, and environment selection, a new `SessionSettings` panel, and a purpose-built mobile chat header/bottom bar gated behind the `NEXT_PUBLIC_CHAT_UX_V2` flag. Message receipts (model · effort · cost · duration · tokens) are now persisted with each assistant turn and rendered consistently in history.
- **Unified Evals workspace** (Claude): new combined evals home + dataset detail page replaces the old drawer-based flow, adding run-list/run-series views, a provider/model picker, and dataset actions (`29ab0173e`, `bb6b8154b`).
- **Repo branch listing capability** (`repoBranchList`): new contract, API route (`GET /repos/branches`), and MCP tool (`repo.branch.list`) for listing branches on a connected GitHub repository.

### Fixes

- **Billing**: fixed a production build blocker from a missing `numeric` import in the billing schema, added regression smoke tests, and exempted automations-list reads from the billing admission gate (`df3a7406d`, `15ca79a37`, `26139a46e`).
- **Database**: removed stale Drizzle definitions for tables/columns that had already been dropped, fixing a schema-conformance mismatch (`66fb40b2b`).
- **App**: workspace skill references now resolve by slug instead of public ID (`b4a8232ac`); moved a `Date.now()` call out of `MemoriesPanel`'s render body into a helper to satisfy React purity rules (`55259ce1e`).
- **CI / gate stability**: closed three UI-parity gaps blocking the `checks` job on `main` (`5df8e9d0f`); fixed local gate flakiness caused by env leakage, tight real-timer margins, tenant slug collisions, and invalid workflow YAML (`e8e06e9ec`); fixed the `parent-route-redirects` e2e wait primitive and a `provider-model-picker` typecheck issue (`b9cdc869f`, `cd20e0006`); resolved an `access-review` e2e slug collision and a missing audit column on `catalog_servers` (`fae67044e`).
- **Config**: regenerated `.env.example` from the env registry to include newly added variables (`3d1ed48af`).
- **Docs**: corrected the CLI splash `stop()` docstring — the cursor is never hidden (#1031/#1035).

### Internal

- Added billing schema smoke tests as a regression guard for the numeric import fix.
- Rewrote the evals e2e write-path spec and dataset-detail tests for the new page-based flow; biome/a11y formatting cleanup in evals UI (Claude).
- Documented gate gotchas, test parallelism guidance, migration targeting, and release script flags in `AGENTS.md` (`44223dc0f`).
- Re-triggered CI after a dropped `synchronize` event (`fc2e311b3`); miscellaneous checkpoint commit.

## v2.0.0

This release ships **web-app-2.0** — a ground-up reorganization of the app's information architecture across six phases (core surfaces, knowledge, automations, workbench/marketplace, governance/security, and a settings/settings-nav merge) — alongside a unified Evals experience, a redesigned workspace Overview HUD, a Sandbox UX overhaul, and a major database hardening pass (six migration batches dropping zombie tables/columns, adding constraints, and fixing tenancy/authz correctness bugs). The standalone `bench/` benchmark suite has been retired in favor of the public `agent-arena` repo. `check:ui-parity --strict` is now a hard CI gate, and a large number of typecheck/e2e/migration regressions accumulated during the 2.0 rewrite were fixed to get `main` green.

### Features
- **web-app-2.0 rollout**: Phase 0 shared primitives + route shells, Phase 1 core surfaces, Phase 2 Knowledge refactors + Settings merge, Phase 3 Automations cluster, Phase 4 Workbench + Marketplace, Phase 5 Governance + Security, plus a re-grouped sidebar nav and collapsed legacy redirect shims into `proxy.ts` (#976–#980, #991).
- **Evals**: unified runs into a single Evals surface — drawers converted to full pages, provider/model dropdowns, and run analytics (#985), plus the previously-missing Evals UI (#994).
- **Workspace Overview HUD**: metering KPIs, knowledge-graph hero, and activity/automations/usage/memory panels, backed by `graph.stats` growth data (#984).
- **Automations**: schema-driven trigger-condition builder, consolidated onto the automations surface (#991).
- **Sandbox**: full UX overhaul — new detail layout, light-mode terminal, env/packages editors, list redesign, and a files bug fix (#986); editable Packages section (manager + chips) on sandbox templates (#995).
- **Agent plans**: persistence for plan approvals plus `get`/`list` APIs (#1017).
- **Ingestion**: webhook-subscription provisioning and renewal wired end-to-end (#1018).
- **CLI**: startup splash for instant feedback while the REPL module graph loads (#1022).
- **PSO**: storage-manifest generator and ADR-031 (Phase 1) (#1012).
- **MCP**: secret/API-key entry UI for secret-auth servers (e.g. Stripe) (`390df4f31`); DB-backed workspace MCP servers wired into the CLI turn (`81cc30998`); fixed the dead re-auth deep link and built out the OAuth landing experience, redirect-back-with-toast on authorize failures, customer-safe GitHub OAuth error copy + operator runbook, and persisted token expiry to revive proactive refresh (`5a312a9ed`, `938b8e44c`, `785d67824`, `979f38906`).
- **Chat**: calm three-card Agent Activity Rail (Progress/Context/Outputs) (`8305ff45e`).
- **Org workspaces**: new listing page fixing the previously-broken Workspaces nav (`9f93abdb4`).
- **DB**: `governance` catalog data source — capability registry `list`/`get` and IAM role `list` read APIs, plus auth-alerts get/set.

### Fixes
- **Database**: six migration/hardening batches — dropped zombie tables (`auth.credentials`, `billing.usage_records`/`org_billing_profiles`/`invoice_line_items`, empty `graph` schema, ltree remnants) (#1003, #999, #1006, #1021), dropped 16 dead columns and wired dunning anti-spam stamping (#1011), added missing indexes/constraints/CHECKs and a numeric money type (#1014), enforced one principal per `(org_id, parent_user_id)` for authz correctness (#1013), promoted workspace `description`/`promptConfig` out of settings JSONB to fix a lost-update race (#1015), and repaired a missing `appendOnlyAuditMixin`/`usage_records` syntax error plus a zombie-table resurrection that made `main` unparseable (#1020, #1021).
- **CI/typecheck**: unbroke `main` across several rounds of typecheck failures (eval-dataset tests, provider-model-picker, memories-panel merge collision) (#1016, #989, #996, `90eea91ef`, `96d67bc56`); regenerated the contracts barrel to import `eval.run.list`/`series` and `agent.mcp.resolve`, and dropped a stray `app` layer from `list_eval_runs`/`get_eval_run_series` (#1001, #1000, `d8d5bb681`).
- **e2e**: fixed access-review role/tab assertions and slug collisions (#1008, #1002, #997), sandbox-template-packages strict-mode locator, parent-route-redirect wait primitives, and mobile bottom-bar nav assertions for the new 2.0 IA (#1005, #998, `ec08aa485`, `d2c1e6ea0`).
- **App**: fixed a shell hook-order crash on org→workspace navigation (`9ad8a1244`), parent "default tab" routes 500'ing under Cache Components (#988), the duplicate `/account/*` tab strip (#987), and workspace cards linking to the redirecting root instead of `/ask` directly (`33fa84c37`).
- **Tooling**: `check:manifest` now content-scans combined route files, eliminating 78 false-positive API-gap reports (#981); gated NO_COLOR allowlisting for `env:check`, stale `mobile-parity` entries, and an atlas checksum mismatch (`2369314cf`).

### Internal
- Retired the standalone `bench/` benchmark suite (`context-eval`, `rag-eval`, `swe-bench`, `terminal-bench`, `bench/web`, `BENCHMARK.md`) — superseded by the public `agent-arena` repo (`16902570e`).
- Removed the app's Activity section (Runs, Fleet, run-detail) (#992).
- Ratcheted `check:ui-parity --strict` into CI as a hard gate on top of `check:manifest`/`check:contracts` (`fcddd4fb4`).
- Regenerated `cli-settings-schema.json` for agent `mcpServers`/`skills` (`bbbd85e9c`) and the capabilities manifest/contracts barrel for the new routes above.

## v1.1.3

This release lands a major wave of platform expansion since v1.1.1: the new Rust-based **Stella** coding-agent CLI (engine, tool/MCP/pipeline/fleet crates, multi-provider BYOK adapters, and a TUI), a redesigned **Workbench** (formerly Studio) with card-grid list UIs, fleet time-travel replay/bisect/resume, a verified-outcome market router, a mutation-verifier gate for agent edits, first-class sandbox multi-repo/terminal support, reseller-revenue billing, multi-tenant GitHub App connect, and a broad mobile-parity and rate-limiting hardening pass. It also carries a very large number of CI, database-migration, and coverage-gate stabilization fixes accumulated across the development window.

### Features
- **Stella CLI**: new Rust coding-agent product line — `oxagen-core` engine (retry/backoff, role router + circuit breaker, budget guard, loop detection), `oxagen-tools`, `oxagen-mcp` client, `oxagen-pipeline` staged orchestration, `oxagen-fleet` planner/worktree/PR monitor, `oxagen-graph` code indexer, `oxagen-media` generation, and a ratatui-based TUI, with BYOK adapters for OpenAI, Anthropic, Gemini/Vertex, Bedrock, and Z.ai, plus a skills/self-improvement loop (`54fb62359`, `dc5368d71`, `e783303a8`, `9e92d232d`, `d18e4a96d`, `1d7e2b790`, `41d58ee1e`, `c998167ab`, `ba757c476`). Official marketing site and docs shipped at `/stella` (`12a583db6`, `fd5dc8b7b`, `a99ce1ca6`).
- **CLI REPL overhaul**: always-parallel Dispatch mode, Files Touched/tasks/swarm/marketplace/prompts panels, `ask_user` clarification survey, create-wizard for commands/agents/skills, background monitor service, and default worker-model auto-routing (`02cfcf56b`, `79978a087`, `7f53b1683`, `73afd41fa`, `97920e8fb`, `c444c710e`, `ccce978a2`).
- **Fleet time-travel** (ADR-028): deterministic session recording with replay/bisect/resume/feedback/distill, backed by a new `@oxagen/replay` package (`9d244f6f1`, `82eec625d`, `fcd18e982`).
- **Sandbox**: first-class multi-repo cloning, template manifest editor GUI, real-terminal console + files drawer, rename/list capabilities, truthful lifecycle reconciliation, and command-output capture to ClickHouse (`c1b17df26`, `f48e46ff3`, `ae97c6083`, `10a4609d8`, `3104a26b5`, `a52238301`).
- **Market router**: verified-outcome routing decision core, telemetry, capability registry, and `oxagen router` CLI group (`25667ea92`, `563c90bf4`, `c70c37a35`, `828814f75`).
- **Mutation verifier gate** (ADR-029): hash-anchored, syntax-gated, audited file edits that prove tests witness a fix (`f8f75ba6b`, `7f663a0e8`, `6fc287e2e`).
- **Reseller revenue billing**: customer/plan/rule/rebill schema, handlers, API routes + MCP tools, and a `/billing/revenue` UI (`589c66720`, `95bb7bdcc`, `4245c388f`, `252ed7198`).
- **Multi-tenant GitHub App connect** (ADR-027): identity-OAuth leg, installation registry, attach gate (`cb6d72077`, `ea3f37c43`, `d2d353fd6`).
- **Chat @-mentions**: reference grammar and an agent-picker panel/gallery/chip wired into the composer (`82ef92bba`, `06fb58e0c`, `a8ef92a01`).
- **Avatar Maker** shipped across agent, workspace, and org surfaces with a shared `EntityAvatar` (`5c5db3cce`).
- **Workbench** (renamed from Studio): denser agents list, tools catalog as a searchable/paginated card grid, sidebar-first IA, and mobile section nav (`a6b03cf9a`, `ab6ca4b75`, `1a79778cb`, `b0a4352eb`).
- Distributed org/workspace-keyed rate limiter on chat + agent surfaces (`e63ae3d3d`); JIT access requests minted from kernel `pending_approval` denials (`28b0c8285`).
- Mobile feature-parity scanner + manifest (ADR-026) and two mobile UX hardening passes (`d2e7f0c7f`, `9e22f3167`, `16e2c52e3`).
- Speculative tool execution — prefetches likely next reads while the model thinks (ADR-030, `5ed324376`).

### Fixes
- `ocp-host`: map BrokenPipe writes to `ProviderCrashed`, deflaking dead-child tests (`9e3c6def8`).
- `agent-engine`: deterministic F1 localizer deadline short-circuit (`361cc55e5`); deferred stream-stall watchdog while a tool executes (`723c798be`); repaired merge-corrupted braces in `tools.ts` and the `readFileTruncationMarker` helper (`d038d6a23`, `a9c3a88eb`).
- CLI: fixed busy-submit triage, orphan auto-resume, killed-agent glyph, `/worker-model` pin during fleet fan-out, and deterministic Enter delivery in the `ask_user` survey test (`0d56f8d39`, `fcc8babb3`, `34dc6ab7b`).
- App: swallowed chat-stream failures made observable, MCP OAuth outbound fetch bounded with a timeout, org-create double-submit on redirect, sandbox log-line shape + NaN duration/byte guards (`b02f9ec42`, `08633b012`, `51120439a`, `00c5e86ae`).
- Billing: deduped reseller RLS manifest entries and fixed payment-receipt email on `invoice.paid` (`723200106`, `5e4ca60fd`).
- e2e stability: exact sandbox-template "default" badge locator, soft-navigation handling in the agent-stream mock, and files-zip race fixes (`6dce13d0e`, `becf33607`, `8ec88a88c`).
- Many database/CI repairs — repeated `atlas.sum` resyncs, RLS manifest registrations, and out-of-order migration resequencing accumulated during parallel merges (`bc6680857`, `0bf6a7200`, `67a667f2f`, `33a3452d6`).

### Internal
- Dead-code sweep: removed the abandoned Fleet orchestrator copy, the never-wired `code_map` tool seam, the unwired `monitors` subsystem, and the inert embed pipeline/quantize code (`8019c5f30`, `377e91ab9`, `966a684d0`, `786273bf3`).
- Coverage-gate hardening across `apps/api`, `packages/oxagen`, and `packages/plugins` branch/function coverage (`945a675c9`, `9df2d7850`, `535a1c016`).
- Repo hygiene: relocated single-importer `lib/` files next to their only caller and broke several app/cli import cycles (`079946c84`, `70b3db80a`, `ae28cdb3e`).
- CI: bounded turbo concurrency to prevent OOM kills, added a dedicated rust-cli workflow, and a canary diagnostic workflow (`72a0a41df`, `5f7089f87`).
- Docs: added ADR-026 through ADR-030, regenerated capability docs, refreshed CODEMAPS, and published a web-app-2.0 IA spec and platform-ratings report.
- Reverted an in-flight `oxagen-*` → `stella-*` crate rename back to the original naming (`8dd521b96`).

## v1.1.2

This release ships the reseller-revenue billing system, sandbox templates with agent environment bindings, a distributed rate limiter, and a reworked chat experience (agent picker, @-mentions, conversation file downloads). The `studio` surface has been renamed to `workbench` across the app, CLI, and docs, and a large body of dead code, import cycles, and orphaned subsystems were removed as part of an ongoing cleanup pass. Several P0-severity fixes landed for token-flooding sandbox output, silently-swallowed chat-stream failures, and unbounded MCP OAuth fetches.

### Features
- **Reseller revenue**: full customer/plan/rule CRUD, re-bill preview & push, Stripe Connect, and encrypted settings — schema, handlers, API routes, MCP tools, docs, and a `/billing/revenue` UI (`589c6672`, `95bb7bdc`, `4245c388`, `40c1b8b2`, `252ed719`)
- **Sandbox templates & agent environments**: portable templates distributed via plugin packs, per-run provider/image/resource overrides, CLI verb groups, and a Workbench UI for managing bindings (`9133f9f5`, `9c6a6d4e`, `5bb045d9`, `3c54d47a`, `02143f88`)
- **Sandbox logs**: command output capture to ClickHouse, `list_sandbox_logs` capability, and an inspector UI with state/console panels (`a5223830`, `87a4199e`)
- **Sandbox tooling**: ripgrep/fd/fzf shipped in every sandbox with grep/find/glob aliases (`bee2a3d0`), plus a `rename_sandbox` capability (`10a4609d`)
- **Agent picker**: new panel/chip/gallery components wired into the composer, workspace default-agent preference, and picker gallery surfacing the workspace default first (`30e3c27b`, `06fb58e0`, `04340cf3`)
- **Chat @-mentions**: mention grammar, picker, chips, and agent wiring in the composer (`a8ef92a0`, `82ef92bb`)
- **`ask_user` clarification tool**: new engine tool plus `SurveyPrompt` REPL component for interactive clarification (`097dc955`)
- **Conversation file downloads**: download all conversation files as a ZIP archive (`6c13df54`)
- **Conversation-grounded suggested prompts**: composer chips are now task-shaped and grounded in the current conversation (`c14f5c74`)
- **CLI**: Files Touched panel with per-edit git diffs in the REPL (`7f53b168`), a deterministic turn resolver that skips the model for template-solvable artifacts (`92f883d6`), a rebuilt `oxagen view` agent-audit dashboard (`9414e265`), and background monitor service scaffolding (`c444c710`)
- **Multi-tenant GitHub App connect**: identity-OAuth connect leg, installation registry, and attach gate (`cb6d7207`, ADR-027 `d2d353fd`)
- **`revise_agent_def` / `revise_skill`**: new capabilities and MCP surfaces (`50b77460`, `246bb8a7`)
- **Distributed rate limiting**: org/workspace-keyed limiter on chat and agent surfaces (`e63ae3d3`, `8a1d4bf7`)
- **JIT access requests**: minted automatically from kernel `pending_approval` denials (`28b0c828`)
- **Mobile parity**: feature-parity scanner + manifest (ADR-026), mobile reflow and 44px touch targets across settings and chat (`d2e7f0c7`, `095ee14a`, `9e22f316`, `d439454b`)
- **Workbench** (renamed from Studio): sidebar-first IA, agents/skills/tools/sandboxes as card grids with avatars, search/sort/pagination/CSV export (`b0a4352e`, `fe4554af`, `1e202f7d`, `027f408f`, `5c5db3cc`)
- **Explore**: graph explorer now seeds from source ontology by default with an agent-activity toggle to reveal lineage (`c3f60c68`, `38dca2ce`)

### Fixes
- Clip unbounded sandbox stdout/stderr before it reaches the model — prevents token-flood failures (P0, `397c6e1a`)
- Surface previously-swallowed chat-stream failures instead of failing silently (P0, `b02f9ec4`)
- Bound MCP OAuth outbound fetch with a timeout (P0, `08633b01`)
- Fail closed (pin-or-reject) on external MCP tool descriptor drift (`9886e71d`)
- Race-safe dedupe for pending IAM access requests (`4c616120`)
- Fix double org creation caused by a re-enabled form during `window.location.assign` (`51120439`)
- Fix reseller-revenue mutations incorrectly surfacing `surface_denied` (`87455cfc`)
- Fix evals sections throwing `surface_denied` on every render (`d3b703d6`)
- Mount the connector setup wizard at the correct marketplace route (`af877dc0`)
- Fix MCP "Authenticate" for registry-installed servers (`49b1433c`)
- Give sandbox `setup_cmd` a credential channel and clearer git errors (`4190200b`)
- Remove the blinking stream caret from chat text segments (`d9962e28`)
- Dedupe duplicate "Active Active" badges on agent cards (`078a6be7`)
- Send a payment receipt email on `invoice.paid` (`5e4ca60f`)
- `getFullHistory` now resolves the full fork ancestor chain (`a7c8590d`)
- Enforce never-push-to-default-branch across repo write capabilities (`14b0c618`)

### Internal
- Renamed `studio` → `workbench` across app routes, lib, e2e, capability metadata, and prompt templates (`b0a4352e`)
- Deleted the never-wired Fleet orchestrator, `code_map` tool seam, model-cache module, and embed pipeline/quantize dead code (`8019c5f3`, `377e91ab`, `ac6b6c23`, `786273bf`)
- Removed the 5 handler-less relationship capabilities and the unwired `monitors/` subsystem (`1e54acd6`, `966a684d`)
- Broke several component and type-level import cycles (chat-shell, memories, CLI ports/schemas) (`ae28cdb3`, `70b3db80`, `8238b1a4`)
- Relocated single-importer `lib/` files next to their only callers (`079946c8`)
- Consolidated dedupe of `estimateTokens`, `extractCandidates`, `formatClock`, and markdown-registry loading (`856e5593`, `68c35e81`, `a436ddde`, `4cc28a60`)
- Distributed capability-manifest and contracts-barrel regenerations to keep parity with new reseller/sandbox/agent-env contracts
- Numerous CI stabilization fixes (ADR-025 naming, RLS manifest registration, lockfile importer drift, Storybook/typecheck repairs) across the pipeline

## v1.1.1

This release delivers a major MCP authentication overhaul (OAuth detection + self-healing install flow), AI-assisted setup wizards for agents and skills, a new sandbox-templates system for portable agent environments, a from-scratch CLI Mission Control / fleet management surface for running multiple agent sessions, and a platform-wide standardization of capability naming (ADR-024/025) that touches nearly every contract, handler, and route. It also includes a large batch of infra, CI, and marketing-site fixes, plus numerous CLI stability and UX improvements.

### Features
- **MCP Servers install→authenticate UX**: detects OAuth-protected MCP servers at install time, self-heals on OAuth callback, and surfaces credential/auth status in the UI (963739c2, 2f02968c, d3a00e00, fd89dd2a, d4df88bb)
- **AI-assisted setup wizards**: new `agent.definition.suggest` capability powers an AI-assisted agent builder flow, and a new `skill.draft` capability powers a 3-step AI-assisted skill wizard in Studio → Skills (5bb94881, 7f8beed6, c9c79416, 6e26b2e7, 55727caa, e6fbfce5)
- **Sandbox templates & agent-environment bindings**: new database schema, 12 contracts, handlers, and a sandbox-template service for portable, reusable agent execution environments (4ef9399f, 5a113296, d89b6d99, dc5ede55)
- **CLI Mission Control & fleet management**: new `oxagen fleet` command tree (dispatch/ls/watch/attach/send/cancel/logs/clean/worker) with a full session-fleet runtime, plus a Mission Control TUI for multi-agent oversight (49cdc094, 322e096b, e7dc31f7, f360bd2d)
- **CLI `/diff` panel**: keyboard-navigable changed-files list with syntax-highlighted, line-numbered diffs (32fb14ba)
- **CLI usage/budget metering**: per-turn streaming usage/cache capture with a per-task budget cap, plus a machine-readable solve-path cost/token/step summary (9d415ace, 33b729af, 5b47b76a)
- **CLI per-function model config**: `/triage-model`, `/judge-model`, `/worker-model` (fc7f0afa)
- **Marketplace consolidation**: agent equipping folded into Studio → Agent Tools; marketplace becomes two-sided, with inline agent equipping and a thumb-first mobile wizard (5765ebb1, a5699b37)
- **Chat improvements**: per-turn conversation-aware suggested prompt chips, a coding-trace-panel + workspace-context-panel rail, a compact Agents card, a prompt-cache token-layer meter, and syntax-highlighted light/dark code diffs (78733efd, a48e0317, 2297f09e, e8f3900d, a14e6111, 4dd80a26)
- **One-thumb mobile settings nav**: bottom-sheet section switcher with responsive layouts (3da6e201)
- **Unified-diff patches**: `repo.edit`/`file.put` now emit a proper unified diff (90c8c030)
- **Ebook lead-gate & interactive reader**: new CMS schema, lead-gate API/email, and an interactive page-flip book reader on the marketing site (ee242a28, 72d91229, e28303ad, 9a042804, 1aa5a274)
- **Immutable agent/tenant identity (ADR-024)**: namespaced, immutable `org_ns.workspace_ns.slug` agent identity; agent slugs are now permanently reserved (no recycling); immutable namespace exposed on org/workspace reads (d12de961, 97f28d0a, 3e41ed47, 94e98611, e0931a5c)
- **IAM principal attribution**: IAM principal threaded through handlers/scope/audit, with usage breakdown by capability and acting principal (e174b313, 70b3398a, 2b2c25b4, a845b083)
- **UI Capability Parity enforcement**: `check:ui-parity` gate ensures every human-operable capability has real, working UI, backfilled for 45 app-surfaced capabilities (09fb1984, fc5b3449)
- Animated adaptive terminal SVG for the landing page, and new investor/roadmap decks (12cf6455, 74ee1230)

### Fixes
- Founder headshot broken image link on decks (be986d0b)
- `vercel-migrate`: direct binary download with an exact pending-count guard; production migrations now auto-apply in the Vercel build (0ca3a787, f11a56bb)
- Marketing site: fixed CORS for apex/www, rewired the demo form to CMS leads (a998f329)
- CI: Postgres/ClickHouse/Neo4j migrations now run unconditionally in the test job instead of being gated behind a (broken) diff check (88470820)
- Removed the non-functional first-party GitHub MCP integration and its dangling imports (8ea38530, 713f6663)
- Skills: builtin skills are now embedded as bundle-safe module data so `create-agent` never bricks (699bb8d6, 267d088d)
- Chat stream now surfaces the real error body on attachment failures instead of a generic 422 (0a1be81c)
- Marketplace: re-clicking the active tab no longer blanks results; connector delivery methods (`rest_polling`/`sql_query`) show human-readable labels (7c1f3e29, c173b926)
- Agent Builder equip-source fetches are now timeout-guarded so the wizard always renders (d7256c01)
- Reject impossible org/workspace slugs before hitting the database (b3425074)
- Correct pricing for `gpt-5.5-pro`/`gpt-5.5`/`gemini-3-pro` from gateway truth (6813cbe5)
- Restored the bench/web importer accidentally dropped by a sparse lockfile regen (a2494913)
- CLI: hardened slash-arg expansion and fuzzy-ranked slash menu (a2ad55d6); idle Mission Control's render timer when the fleet is quiet (893634a6); removed fabricated "live" telemetry from `oxagen view` (191a126d); fixed fullscreen transcript scrolling and height estimates (71712f3f, 731cde23); fixed Mission Control composer misrouting fast-typed input (972e9cc6); memoized `MessageView` and deduped spinner frames (515d81e4)
- CLI: bounded detached worker sessions by max-lifetime/RSS ceiling and plugged lifecycle leak seams (9b0e9cc4, ef926f64)

### Internal
- **ADR-024 / ADR-025**: standardized all 294 capabilities to verb-first `snake_case` naming, removed the legacy alias mechanism, and reconciled the resulting handler/route/UI/telemetry/test surfaces platform-wide (4d25360a, 08bc5ce0, 21057706, 986d72f6, 70e6fd4d, a161c7b3, b566e106, and numerous `reland`/reconciliation commits)
- CLI commands migrated onto a "universal output discipline" (consistent JSON envelopes) across settings, telemetry, agent, command, rules, config, graph pull/lineage/push, replay, recover, asset upload, a2a card, conversation export, file-lock, and the daemon lifecycle (87abc83a, fd105cfe, 063c7426, 6e23e962, 834787d5, 863129f1, edcb2b34, d4cc1342, e841b849, b64652ed, 843c58b4, 9df0a595)
- Removed dead code paths: the cloud `ModelProvider` runtime half and `createTurnRunner` (7c8214fd, 10c35a44)
- New reusable manual DB-migration GitHub Actions workflow for applying Atlas migrations to prod on demand (62f9a9a1)
- Batched IAM role-grant seeding in 500-row chunks; capped CLI/bench cache TTL at 1h with a per-task max-steps cap (7ad4bdf7, 5b47b76a)
- Expanded test coverage across CLI (fleet, mission control, session runner/manager, diff panel), MCP OAuth flows, contracts, and kernel dispatch probes
- Docs: ADR-024/ADR-025 write-ups, sandbox-templates implementation plan, RBAC design specs, prod IAM re-seed runbook, and refreshed CLI reference docs (custom commands, REPL slash commands, agent engine, memory, models)

## v1.1.0

This release lands three major architectural efforts: the ADR-021 deterministic-first inference doctrine (judge tiering, fast-path planning, structured tools), the ADR-022 capability naming standard (a repo-wide rename of `domain.subject.action` contracts with alias-shim backward compatibility), and the ADR-023 CLI fleet/session-event-log redesign (detached session dispatch, a universal output layer, and a filesystem-backed event store). On top of that foundation, the app gains a new Studio (Agent Builder, Tools, Skills), a Marketplace surface, per-turn dollar budget governance across CLI/app/API, Postgres-backed file locking for concurrent agent edits, conversation export, and a round of mobile-usability and chat-context work. A large number of merge-repair and CI-stability fixes round out the release.

### Features

- **CLI fleet & session redesign (ADR-023):** session event envelope/ids/paths + filesystem store (`d09ce467`), universal output layer + aggregate timeline formatter (`401c3fb6`), detached session dispatch unifying fleet dispatch and REPL `&` (`bccaea8a`), REPL trailing-ampersand backgrounds a prompt into the fleet (`ec31e77e`), scope-review gate + always-on scope card + Ctrl-O verbose + heartbeat (`cab79f82`), per-function model config via `/triage-model`, `/judge-model`, `/worker-model` (`83eaf114`).
- **Inference doctrine (ADR-021):** deterministic single-task planner fast-path (`0e0db957`), judge-skip on by default (`92961a36`), triage-model plumbing + judge tiering (`976b1aa3`), fast-tier planner default + best-of-N short-circuit (`320f93e8`), structured tools wired and renamed to `domain.subject.action` (`56540d91`), shared coding-core system prompt (`92ba4b5b`), optional pre-execution scope-review hook (`37860f80`).
- **Capability naming standard (ADR-022):** collapsed 4-segment capability names with domain dedupe and alias shims (`0e974d94`), naming lint + `check:contracts` (`704278d0`), capability alias resolution infrastructure (`b876c336`).
- **Per-turn budget governance (OXA-2081):** contracts/engine gate/schema foundation (`c3e94fb7`), turn budget guard threaded through the run pipeline (`9506a516`, `b8c68aa2`), API routes/MCP tools/docs for `budget.policy.*` (`84ffe160`), CLI `--budget`/`--budget-mode` flags + `/budget` slash command (`70e917ce`), app composer control + stream-route enforcement with 3 modes (`dde1f1c3`).
- **File locking (ADR-021 §5):** Postgres file-lock lease with fencing tokens (`6a83f1d8`); mandatory per-session file locks for the CLI (`2d5a2f87`).
- **Studio & Marketplace (app, Phase 1):** Studio foundation with nav/routes/invoke wrappers (`e1130ed1`), Agent Builder — list + 7-step builder (`af870fcd`), Studio Tools + Skills + chat↔agent binding (`11b9f9ab`), Marketplace — Browse/Installed/MCP servers (`584dd0a6`), agent selector in new-session flow + code-agent-gated UI (`bf84d362`), code-agent identity infrastructure (`fe9e2499`).
- **Code mode & sandbox:** Code mode toggle with forced repo/environment gate in the composer (`f5cf89da`, `b2e3f516`), code-mode chat system prompt (`9581fe58`), code mode bound to the durable sandbox in the chat stream route (`932c6099`), `ModalSandboxWorkspace` + environment-secret injection (`c7f8244b`, `5163afd7`), sandbox visibility panel with status strip and lazy file tree (`ec85a8e6`), `agent.sandbox_file.read` capability (`46e69b85`).
- **Chat context & tooling:** git diff / PR stats / CI status cards, pinnable repo+env context, slash commands (`c7782186`), conversation export (PDF/Markdown) as contract, API route, MCP tool, CLI command, and UI menu (`2eafb74b`, `6d2ae593`), SVG in-app preview and mobile-usable Files panel (`b3dd2e4f`), graph-grounded citation demo in chat (`8d99adb5`).
- **Mobile usability:** collapsible chat composer (`379a2aca`), mobile-usable knowledge graph explorer (`db3ea425`).
- **Storage:** filesystem storage driver + CI wiring, removing the Vercel Blob token requirement (`a4eb199c`).
- **Telemetry & debugging:** `telemetry.error.cluster` fleet-wide error triage (`eae82f31`), `agent.debug.trace` structured failure diagnosis (`2c8ba588`).
- **Engram:** nightly consolidation wired with idempotent reinforcement, deterministic distill identity, and TTL eviction (`6fa42cb3`).
- **Web:** oxagen.sh marketing one-pager with gated field-manual ebook (`055cd31e`).
- **MCP:** 6 missing repo MCP tools added, with contracts declaring MCP surface (`50ada5d8`).

### Fixes

- Repaired several post-merge regressions from PRs #658/#659/#630/#648, including duplicate agent-binding logic/broken JSX (`ff2cd42f`), stale tests/naming/env (`0b8bb4aa`), and a dropped `DEFAULT_AGENT_MODEL` import (`6680af9c`).
- Chat: pin selectors now show the env/repo label instead of the raw system id (`12864c82`, `9475bd5b`); retry resilience, id-based history dedup, persist-failure warning, NUL-key fix (`f8ffdbe9`); import slash commands via a client-safe subpath (`83234044`); synced `parseAttachmentsField` so text-only sends no longer fail with "Invalid message" (`7ba6c7d5`).
- CLI stability: throttled streaming renders, memoized measurement, zombie reaping, clean signal exit (`350ac1a2`); native copy/paste by default with line-count paste chips (`9bbf79d8`); stopped `settings.json` from silently masking model/env (`6e5182ea`); model-mask warning, split-brain get, scope-shadow warning, doctor precedence fixes (`4c4b8580`); atomic writes and dead-key write rejection for workspace config and credential store (`503396ed`, `86384089`); flush error debug entry before process exit (`97eba19d`).
- Agent engine: balanced judge default, multimodal token estimate, retry buffering, empty-error and cache-aware projection fixes (`7bffc740`); tool-routing precision for graph/code tools (`0e8d8ac3`); dropped dead `no-control-regex`/`no-console` lint suppressions (`ea01480a`, `7043aedc`).
- Engram: made the sync/ CRDT layer convergent (metadata-aware Merkle, stable bucketing, OR-Set/PN-Counter invariants) (`f87a041a`); fixed live-path retrieval/budget/hash correctness (`b10241e8`); stopped an API boot crash via lazy bundler-safe `createRequire` (`c2630fe4`).
- Presenter decks: fixed presenter mode reconnecting instead of dying after one open (`96aeafa6`).
- Repaired multiple CI-blackout/gate regressions across `apps/app`, contract-seam env tests, and Group 3 gate failures (`32c0f271`, `cf24d258`, `07e8311f`, `a334c818`, `636da026`, `248f7374`).
- Database: tenant-policy manifest count corrected for new file-lock tables (`1b3f4cd7`); MCP coverage-config tool paths updated for ADR-022 renames (`2de9e81b`).

### Internal

- Repository-wide capability rename to `domain.subject.action` across API routes, MCP tools, handlers, and contracts, with regenerated docs/schemas and capabilities manifest (ADR-022 follow-through).
- Added ADR-021 (inference doctrine), ADR-022 (capability naming standard), and ADR-023 (CLI fleet session-event-log) design docs, plus specs for the CLI interface redesign, app-parity UI overhaul, and graph file locking.
- Extensive new test coverage: detached-dispatch contract, structured-tools parsers/integration, CRDT sync invariants, budget guard, file-lock lease, storage fs-driver/integration, conversation export serializer/handler/MCP/CLI/UI, agent selector, mobile hooks, and more.
- Refactors: deduped rate-card/model-router/trace/fleet types onto `@oxagen/agent-engine` and routed the CLI planner through the `AgentAi` port (`29c8d53c`); deleted the dead `shrink/` module (`a7bc02b7`); extracted shared coding-core system prompt (`92ba4b5b`).
- Performance: parallelized code-graph lookups and cached `generateObject` system prompts (`e355774a`); warmed the code-graph at REPL mount off the critical path (`e576b6f5`); fast path for conversational/lookup prompts (`de1b5e80`).
- CI: added `STORAGE_DRIVER=fs`/`STORAGE_FS_ROOT` wiring for hermetic attachment uploads in the e2e pipeline; regenerated capabilities manifest and lockfiles for the budget package.

## v1.0.1

_Changes since v0.11.0._

- chore(release): v1.0.0 (134cbd01) — macanderson

## v1.0.0

_Changes since v0.11.0._

- No commits since the last release.

## v0.11.0

_Changes since v0.8.0._

- feat(chat): surface graph-grounded citations under assistant answers (#618) (8174690a) — Mac Anderson
- fix(mcp): externalize native duckdb chain in xmcp build (#620) (e271fcf5) — Mac Anderson
- fix(app): resolve react-hooks/immutability lint failures blocking CI (#619) (d007e0f5) — Mac Anderson
- fix(ci): provision Neo4j schema for unit-lane integration tests + refresh stale orgId assertion (#617) (4512710e) — Mac Anderson
- OXA-2070 follow-ups: file-lock CLI/docs hardening + retire blackboard (OXA-2075) (#616) (ed02442f) — Mac Anderson
- fix(ci): cancel superseded push runs on the same branch (#615) (74f1436d) — Mac Anderson
- [OXA-2070] Wire agent-file-locking (blackboard) to Neo4j (#613) (fe378011) — Mac Anderson
- fix(database): validate mcp_servers auth_config encrypted-shape constraint (#607) (34e9a243) — Mac Anderson
- Feat/multimodal phase 2 4 (#614) (7fb4b35a) — Mac Anderson
- fix(agent): wire Vector, Graph, and Lexical retrieval engines into compileAgentContext (#611) (7e1e2889) — Mac Anderson
- fix(telemetry): close branch-coverage gate gap with targeted regression tests (#609) (ad2fb7ae) — Mac Anderson
- fix(ontology): bind orgId/workspaceId explicitly across 16 scopedSession resolvers (OXA-2062) (#608) (52c568ce) — Mac Anderson
- [OXA-2071] Wire engram session/fork.ts + session/replay.ts (trace UI + daemon) (#605) (0ae8302b) — Mac Anderson
- A2A: per-agent identity, execution lineage, live resubscribe (#604) (a532205f) — Mac Anderson
- fix(test): use a genuinely-invalid kind in asset.upload's 400 test (#612) (43ff5bfa) — Mac Anderson
- fix(test): add eval.*/agent.trace.get/agent.sandbox.files.list to route-parity map (#610) (47af5062) — Mac Anderson
- fix(test): mock loadWorkspacePromptConfigSafe in api chat.stream test (#606) (602929aa) — Mac Anderson
- fix: restore two main regressions reintroduced by #596's early merge + fix e2e RLS boot failure (#603) (c417fd4f) — Mac Anderson
- chore:upgrade nextjs 16.2.10 (9a3d97ea) — macanderson
- fix(mcp): add missing publicId to asset.upload mock fixture (#602) (3659e97b) — Mac Anderson
- feat(engram): restore blackboard sub-barrel + graph-file-lock wiring plan (#600) (f1b5520e) — Mac Anderson
- fix(mcp): envelope-encrypt external MCP server credentials (#601) (8f71775d) — Mac Anderson
- fix(ingestion): idempotent ClickHouse conformance events under Inngest retries (#599) (12849abc) — Mac Anderson
- fix(security): fail-closed IAM edges — checkFn throw, 42P01 downgrade, MCP empty orgId (OXA-2056) (#598) (333479ee) — Mac Anderson
- fix(security): durable audit writes + refuse-to-persist empty chain_hash (#597) (c5bcd4bb) — Mac Anderson
- feat(app): multimodal phase 2+4 — video model input + coding-trace/workspace-context panels (#596) (3ecb72ae) — Mac Anderson
- [OXA-2052] Fix ingestion dedup unbound $orgId param (#595) (345fb0ba) — Mac Anderson
- test(ann): add multi-tenant recall regression tests for OXA-1929 (#594) (c88166b2) — Mac Anderson
- fix(app): add missing workspace-membership gate on wand resolve actions (OXA-2049) (#593) (9f0f24e1) — Mac Anderson
- fix(connectors): constant-time secret comparison in Zoom/Microsoft webhook verification (OXA-2051) (#592) (eec5da8c) — Mac Anderson
- docs(memory): record that OXA-2028 (single-source StageKind) is already fixed on main (#591) (9e5c7325) — Mac Anderson
- chore:added new agent skill files (d7574908) — macanderson
- fix(auth): unblock prod migration chain so login works (P0) (5f99d9ce) — Claude
- fix(ci): always reconcile prod Postgres on push to main (P0 login outage) (a837ca0e) — Claude
- feat(cli): markdown rendering for assistant prose in the REPL transcript (#590) (42739621) — Mac Anderson
- chore:added new agent skill files (772af6f8) — macanderson
- feat(app): multimodal coding-agent web experience — image attachments, artifact cards, parity (#589) (15c93166) — Mac Anderson
- feat(cli): banner v2 — gradient OXAGEN wordmark only; version+scope in HeaderBar (#588) (3ee60b0a) — Mac Anderson
- Feat/evals v1 (#587) (604ed143) — Mac Anderson
- Feat/usage dashboard (#586) (20483e17) — Mac Anderson
- feat(cli): sunset-gradient oxagen.sh cli banner, persistent like Claude Code (#584) (e275fdca) — Mac Anderson
- fix(mcp): register agent.trace.get + agent.execution.list in parity test (#585) (1b7bc715) — Mac Anderson
- fix(handlers): drop stale duplicate createPlatformAgentAi import in agent.repo.edit (#582) (4698b0a3) — Mac Anderson
- fix(handlers): audit-exempt the read-only billing.usage.breakdown handler (#581) (70730336) — Mac Anderson
- fix(database): register agent.a2a_tasks in the RLS policy manifest (#580) (e7bf1298) — Mac Anderson
- fix+feat: log swallowed errors and build buildable-now TODO sites (#578) (4b0b42de) — Mac Anderson
- fix(database): register ai.* and eval.* tables in the RLS policy manifest (#579) (e12dedb4) — Mac Anderson
- feat(a2a): Agent2Agent protocol surface alongside MCP (#572) (9c63eff6) — Mac Anderson
- feat(ci): lint atlas migrations for duplicate versions and atlas.sum drift (#577) (694f02b3) — Mac Anderson
- chore(bloat): verified rip-out — dead exports, unused deps, stale assets, zombie schema, dead tests (#564) (a346dcf9) — Mac Anderson
- test(e2e): TOTP 2FA enrollment + second-factor sign-in flow (#575) (1ebde0ac) — Mac Anderson
- feat(observability): light up OTel export + vendor-neutral error alerting + agent run-trace span-tree UI (#574) (145d1f0a) — Mac Anderson
- fix(db): repair atlas.sum corrupted by #569 merge (stale + duplicate entries) (#576) (12992aa3) — Mac Anderson
- reliability: circuit breakers, Inngest idempotency, StageKind drift, loud memory-recall (#570) (f2b5980a) — Mac Anderson
- feat(evals): Evals v1 — datasets + LLM-as-judge over metered run traces (#569) (2e027539) — Mac Anderson
- fix(db): resolve atlas migration version collision + checksum break on main (#568) (87e707ee) — Mac Anderson
- feat(app): run the in-app chat agent on @oxagen/agent-engine (unify execution stacks) (#566) (8d1b9ed6) — Mac Anderson
- docs(capabilities): sync registry — add 30 missing capability docs (#565) (90699379) — Mac Anderson
- fix(handlers): typecheck error in bitemporal ontology test asserts (#571) (dce26615) — Mac Anderson
- fix(mcp): register billing.usage.breakdown in parity test; fix CLAUDE.md migration path; regen .env.example (#567) (6c29b3f9) — Mac Anderson
- fixed package.json (2cd5a81f) — macanderson
- feat(graph): bi-temporal fact validity (valid + transaction time) in the knowledge graph (#563) (2e992ae3) — Mac Anderson
- fix(ci): pass PLAYWRIGHT_BROWSERS_PATH through turbo to test:e2e (#562) (6a28adbe) — Mac Anderson
- fix(security): RLS fail-closed in prod, TOTP 2FA for Owner/Admin, CORS localhost dev-only (#561) (653c09d5) — Mac Anderson
- feat(ai): semantic response cache + Anthropic Message Batches (background inference) (#560) (d379fce6) — Mac Anderson
- feat(billing): usage dashboard — per-model/surface/workspace breakdowns (OXA-1585) (#559) (9f51e8ef) — Mac Anderson
- feat(connectors): generic poll/sync loop — make existing sources real (#558) (0df7f9b8) — Mac Anderson
- fix(app): close apps/app IAM gate gap — gate ungated server actions (IDOR) (#557) (a7cfd88d) — Mac Anderson
- fix(ann): oversample tenant-filtered vector searches to stop silent recall decay (#555) (f742ca02) — Mac Anderson
- fix(handlers): align subagent child fixtures with summary/outputBytes contract fields (#556) (ed8e6e45) — Mac Anderson
- docs: refresh all repo-level docs to Stripe-for-agents vision + current architecture (#554) (406bfcf7) — Mac Anderson
- fix(env-manager): skip chmod-000 unreadable-file test when running as root (a6bc6122) — macanderson
- docs: archive Specs & Plans section with shipped-status verdicts (#553) (ba85446a) — Mac Anderson
- feat(web): apps/web static site — platform health deck as interim homepage (#552) (651336fd) — Mac Anderson
- feat(agent): graph-mediated fleet coordination Phase 2 — claim/lease self-healing, graph projection, peer reads, scaling policy (#551) (9be0e774) — Mac Anderson
- feat(vision): Stripe-for-agents north star + LLM vision gate in CI (#550) (678c6c14) — Mac Anderson
- feat(cli): CI-aware turn inactivity guard — probe CI before aborting instead of a blanket 2h timeout (#549) (d455e95c) — Mac Anderson
- feat(cli): /config TUI panel + /config doctor over the 4-tier governed config (#548) (2ae82500) — Mac Anderson
- docs(specs): oxagen-cache-review — monorepo cache audit spec + phased plan (#547) (b392e2fa) — Mac Anderson
- perf(ci+bench): run CI in prebuilt GHCR toolchain images; prewarm SWE-bench task images (#546) (bb92ab7f) — Mac Anderson
- ci: add GHCR CI toolchain image + publish workflow (bootstrap) (#545) (d1bf7530) — Mac Anderson
- docs(spec): Oxagen Rust CLI — standalone OSS BYOK spec + phased plan (#544) (72d20881) — Mac Anderson
- fix(config): dedupe convergent OXAGEN_CLI_MOTION/OXAGEN_PLAN_TIMEOUT_MS registrations (#543) (5de97a00) — Mac Anderson
- docs(specs): Phase 2 fleet coordination spec + fanout metrics harness + Atlas decision doc (#541) (1bb1428a) — Mac Anderson
- fix(api): parity-map entry for agent.subagent.result.get (main test job red) (#538) (563f833b) — Mac Anderson
- fix(config): register OXAGEN_CLI_MOTION + OXAGEN_PLAN_TIMEOUT_MS, regen .env.example (main env-check red) (#539) (486ed6e3) — Mac Anderson
- fix(config): dedupe DO_NOT_TRACK/OXAGEN_TELEMETRY registry keys (TS1117, main red) (#537) (0bf7afae) — Mac Anderson
- feat(cli): F4b cache-forked best-of-N mode (trunk snapshot + consensus select) (#534) (d8071bb4) — Mac Anderson
- feat(cli): real per-turn planning + fleet subagent fan-out in the interactive TUI (#535) (1d6edf2a) — Mac Anderson
- fix(cli): restore right panel borders; add /motion full|reduced|off animation config (#532) (c20e8a87) — Mac Anderson
- test(cli): spread real agent-engine module in interactive REPL test mocks (#536) (5a8b02a8) — Mac Anderson
- fix(cli): stream token burn live and show pipeline models at TUI launch (#533) (2d79d78d) — Mac Anderson
- test(agent)+fix(api): fanout aggregate follow-ups from test-completeness audit (#530) (8784c752) — Mac Anderson
- docs(specs): correct bench-report-and-dashboard.md to the private @oxagen/bench structure (#528) (d326db08) — Mac Anderson
- feat(agent): compact-by-default fanout aggregate + agent.subagent.result.get (#527) (d58c0a75) — Mac Anderson
- Fix/bench private package restructure (#526) (5b8e570f) — Mac Anderson
- fix(agent-engine): don't let F1 localizer run a second semantic fallback in ENHANCE (#525) (51ca4110) — Mac Anderson
- Feat/bench clickhouse schema (#524) (6706c107) — Mac Anderson
- Spec/graph mediated fanout results (#523) (0cee6797) — Mac Anderson
- fix(cli,bench,config): xhigh/max effort docs, bench effort default, telemetry env registration (#522) (c00da61b) — Mac Anderson
- Worktree feat+model cache effort (#520) (a4d9188d) — Mac Anderson
- Feat/swe rank1 scalpel (#521) (ea733070) — Mac Anderson
- Feat/swe rank1 scalpel (#516) (53e08f18) — Mac Anderson
- feat(cli,api,telemetry): anonymous opt-out CLI usage telemetry (#519) (6ace1e58) — Mac Anderson
- docs(specs): graph-mediated fanout results spec (blackboard-lite) (#518) (d2147ac0) — Mac Anderson
- feat: bench ClickHouse schema, typed ingestion, and oxagen bench list/replay (#517) (e63e749b) — Mac Anderson
- Scalpel: SWE-bench rank-#1 spec + implementation (#514) (01b9d3e5) — Mac Anderson
- feat(scripts): AI Gateway key rotation script (pnpm vercel:rotate-ai-key) (#515) (0339bdc3) — Mac Anderson
- ci: bump test job timeout to 60m for whole-repo-affected runs (#513) (948551d7) — Mac Anderson
- fix(config): regenerate .env.example, register OXAGEN_BEST_OF_N_VERIFY (#512) (f0347e3c) — Mac Anderson
- fix(cli): finish Sonnet 4.6->5 sweep in metrics test, de-flake init-animation TUI tests (#511) (0b9d2317) — Mac Anderson
- fix: repair merge artifacts breaking CI on main (#510) (1904dd61) — Mac Anderson
- Feat/cli input bar animation (#509) (0ff4e091) — Mac Anderson
- fix(cli): stop /mouse stale toggle, bound enhance timeout, fail fast on billing errors (#508) (db732a32) — Mac Anderson
- test(cli): complete the init-animation test suite + fix a real bug + unblock CI (#507) (40464e02) — Mac Anderson
- fix(cli): sweep retired Sonnet 4.6 to Sonnet 5, default balanced tier to Sonnet 5 (#506) (e5304366) — Mac Anderson
- feat(cli,bench): auto-verify test union, N=5 cross-family, apply-fallback, defect fixes (#505) (e8fe85fd) — Mac Anderson
- feat(cli): space-invaders + OXAGEN reveal animation for oxagen init (#504) (d7d48a63) — Mac Anderson
- fix(cli): drop SGR mouse reports in PromptInput so clicks/scrolls don't spray garbage (#503) (0f86348e) — Mac Anderson
- Feat/bench best of n (#502) (2b233727) — Mac Anderson
- Fix/env register cli mouse (#500) (da66041c) — Mac Anderson
- fix(env): register OXAGEN_CLI_MOUSE in ENV_REGISTRY + SCHEMA_EXEMPT (#499) (d53ca9b8) — Mac Anderson
- feat(bench+cli): pipeline-per-candidate best-of-N + differentiated config + init/graph-reuse fixes (#498) (3e321c14) — Mac Anderson
- feat(cli): REPO panel (worktree path + branch + PR#) + worktree-branch fix for the full-screen TUI (#497) (1075edb2) — Mac Anderson
- feat(cli): local, free, AI-SDK-free embedding providers for the code graph (#496) (51199ac6) — Mac Anderson
- fix(env): register OXAGEN_CLI_MOUSE in ENV_REGISTRY + SCHEMA_EXEMPT (#494) (060837cd) — Mac Anderson
- fix(ai): allow system-in-messages under AI SDK v7 — unbreaks every platform CLI turn (#493) (8f9bdc74) — Mac Anderson
- Feat/cli anthropic key fallback (#492) (4940561d) — Mac Anderson
- chore:.gitignore the ai gateway key file (8e0fe56a) — macanderson
- feat(cli): full-screen TUI REPL with in-app scroll and a live-telemetry dock (#491) (5cae1681) — Mac Anderson
- feat(agent-engine): local coordinator + Sonnet 5 / Fable 5 defaults; turbo build green (#489) (4d7046f2) — Mac Anderson
- feat(bench): wire oxagen solve best-of-N into the terminal-bench adapter (#488) (a4ac2bba) — Mac Anderson
- fix(cli): pin FORCE_COLOR=3 in vitest env — deterministic ANSI for slash-menu tests (#490) (cdd346e1) — Mac Anderson
- feat(cli): ANTHROPIC_API_KEY BYOK fallback + AI SDK v7 / provider-v4 migration (#487) (8ca806bb) — Mac Anderson
- fix(env): register OXAGEN_MID_JUDGE_STEPS in ENV_REGISTRY + SCHEMA_EXEMPT (#486) (be8d3737) — Mac Anderson
- docs(bench): benchmark analysis HTML — SWE-bench smoke run findings, process gaps, Rust verdict (#485) (0853d719) — Mac Anderson
- feat(skills): publishable npx installer + CLI install.sh (#484) (cb60df48) — Mac Anderson
- feat(docs): add TUI screenshot-style SVG screens to CLI docs (#483) (43545687) — Mac Anderson
- feat(docs): CLI install landing page, site-wide install button + celebration, doc illustrations (#482) (51fa3f6d) — Mac Anderson
- perf(cli): SWE-bench speedups — bounded enhance, prompt caching, verification budget (#481) (53475a38) — Mac Anderson
- fix(ai): establish tenant scope around post-call credit charges (Inngest billing leak) (#480) (8584a0d5) — Mac Anderson
- Fix/video duration clamp (#479) (e7c404dd) — Mac Anderson
- fix(api): raise Vercel maxDuration to 800s so Inngest video renders survive (#478) (fd9bf5f9) — Mac Anderson
- fix(video): snap durations to model-supported set, surface provider alternatives (#477) (b87d7b77) — Mac Anderson
- fix(cli): render REPL inline so native terminal scrollback works (#475) (ce290613) — Mac Anderson
- Fix the suggested prompts UI in the command menu: (26f0f4c3) — Mac Anderson
- Fix/video duration clamp (#476) (c8f00a87) — Mac Anderson
- fix(agent): structurally block test-file edits (OXAGEN_FORBID_TEST_EDITS) for the bench (#474) (9053f633) — Mac Anderson
- feat(cli): replace cat-mouse thinking animation with rocket-vs-UFO duel (#472) (d49322d2) — Mac Anderson
- feat(cli): slash-menu v2 — uniform cells, amber/green, monochrome lock, no rules (#471) (265909c9) — Mac Anderson
- refactor(cli): clean up the slash command catalog — tighten, group, dedupe (#469) (a82523e3) — Mac Anderson
- fix(bench): upload tree-sitter wasm assets into the container, not just oxagen.mjs (#470) (2b3c5afa) — Mac Anderson
- feat(cli): embed markdown content + tag nodes/edges with domain in code graph (#467) (c2edea09) — Mac Anderson
- fix(cli): local BYOK mode — use AI_GATEWAY_API_KEY without an Oxagen login (#462) (7c9688bb) — Mac Anderson
- feat(cli): paste images + large text as [Image #N] / [Text #N] placeholders (#466) (3606724d) — Mac Anderson
- feat(cli): slash-menu redesign — inline descriptions, per-command product colors, separators (#463) (a231d3cd) — Mac Anderson
- feat(cli): oxagen config commands + multi-scope indexer (phases 4-5) (#464) (a1ad619e) — Mac Anderson
- fix(cli): bundled code-graph broken by __dirname in ESM — the bench-blocking P0 (#465) (34fa0a80) — Mac Anderson
- fix(bench): repair SWE-bench harness for current harbor + pin version (#461) (de896448) — Mac Anderson
- Fix/duplicate solve command (#459) (023903c6) — Mac Anderson
- fix(cli): drop unused activityGlyph import breaking @oxagen/cli lint (#458) (d0b9f8d0) — Mac Anderson
- refactor: derive CodeGraphOperation from CodeGraphProvider instead of hand-copying the union (#456) (e51e263f) — Mac Anderson
- fix(cli): remove duplicate solve command registration crashing the CLI (#457) (8ab2cecf) — Mac Anderson
- --no-verify (af776153) — macanderson
- Feat/cli best of n (#455) (846f46b0) — Mac Anderson
- feat(cli): semantic_search over the local code graph + enhancer fallback (#451) (1c87af73) — Mac Anderson
- feat(cli): fleet cancel-drain, isolate-by-default, and headless --json mode (#453) (c5327154) — Mac Anderson
- feat(cli): shared activity vocabulary + slash single-source + REPL input editor (#454) (7cbe37be) — Mac Anderson
- feat(cli): oxagen pr fix — active fix-to-green loop for PR CI (#452) (ff066da7) — Mac Anderson
- feat(cli): mine recurring lessons into promotable workspace rules (#450) (ead81e15) — Mac Anderson
- feat(cli): workspace config foundation — schema + 4-scope governed resolver (#449) (fe5e6b9f) — Mac Anderson
- fix(engine): remove unused modelForTier import breaking main lint (#448) (fc6dbb0b) — Mac Anderson
- fix(cli): remove dead agent/loop mock + update stale runAgent JSDoc references (#447) (b2a5d211) — Mac Anderson
- feat(cli): oxagen solve — best-of-N task solving with a live multi-lane view (#446) (8e902f0f) — Mac Anderson
- fix(agent): make code_graph a hard, prominent first-move mandate in the system prompt (#445) (d2529a98) — Mac Anderson
- Feat/cli engine unification (#443) (06f7dc5a) — Mac Anderson
- Feat/cli phase2 dead island (#444) (f8804e1d) — Mac Anderson
- feat(cli): engine unification foundation — tool seams + shared extras + one-shot parity (#442) (60f67545) — Mac Anderson
- fix(cli): copy-runtime-assets no longer references deleted dead-island JSONs (#441) (cb1084e7) — Mac Anderson
- refactor(cli): delete ~8,400 LOC of dead code (pre-migration brain island) (#440) (4da9407a) — Mac Anderson
- fix(mcp): green checks — recall test args carry all InferSchema keys (#439) (f6063198) — Mac Anderson
- fix(agent-engine): headless localize step lists only wired locate tools + restore lost profile tests (#436) (7924a78c) — Mac Anderson
- feat(memory): agents recall memories before acting — CLI loops + chat agent self-improvement wiring (#437) (d94cf8c3) — Mac Anderson
- Feat/cli swe bench hardening (#435) (1c383d5a) — Mac Anderson
- Feat/agents graph first context (#434) (2f92935f) — Mac Anderson
- Feat/cli swe bench hardening (#433) (b163ae62) — Mac Anderson
- Feat/agents graph first context (#432) (e80c71b2) — Mac Anderson
- Feat/cli swe bench hardening (#431) (17bf5a0c) — Mac Anderson
- Feat/cli swe bench hardening (#430) (ea96abbe) — Mac Anderson
- Feat/memories sort filter citations (#429) (0e1109d8) — Mac Anderson
- feat(ui): higher-contrast vibrant theme — de-pink light neutrals, ember dev code block, subtle in-app grid (#428) (93dd2985) — Mac Anderson
- fix(config): declare OXAGEN_PROMPT_PROFILE in ENV_REGISTRY (#427) (6a30f558) — Mac Anderson
- fix(app): repoint knowledge node pages to renamed inference route (#426) (a1e60514) — Mac Anderson
- feat(ai): add Claude Fable 5 + Sonnet 5 to model selectors and rate cards (#425) (408102a5) — Mac Anderson
- feat(cli): SWE-bench hardening — step-driver, compaction, retry, evidence judge, headless (#424) (df938d7f) — Mac Anderson
- feat(memories): sort by citation count + filter by minimum citations (#423) (ddf9f06f) — Mac Anderson
- Feat/cli swe bench hardening (#422) (800fe50d) — Mac Anderson
- fix(app): green main — drop stale weight-axis imports + retarget memories edit test to two-axis model (#421) (d6b30684) — Mac Anderson
- Feat/cli swe bench hardening (#420) (d6e76c75) — Mac Anderson
- fix(app): green main — drop stale weight-axis imports + retarget memories edit test (#419) (fe3f710b) — Mac Anderson
- Feat/cli swe bench hardening (#418) (55309e09) — Mac Anderson
- fix(e2e): chat connection-create-inline spec asserts current wizard gate copy (#417) (2defb080) — Mac Anderson
- Feat/cli swe bench hardening (#416) (04080b87) — Mac Anderson
- fix(cli): repair REPL crash on launch (resetPending ReferenceError) (#415) (bea88e96) — Mac Anderson
- fix(cli): repair CLI typecheck + lint clobbered by #403 merge — get main green (#414) (f2f19d8d) — Mac Anderson
- Feat/cli swe bench hardening (#413) (d6be1f95) — Mac Anderson
- Feat/cli swe bench hardening (#412) (c3e775d1) — Mac Anderson
- fix(cli): document /coordinator + Ctrl-O fold in /help; reuse PanelTarget type (#411) (4ba4c9a0) — Mac Anderson
- feat(cli): Fable default (opus→fable) + /coordinator remote|local on-device toggle (#408) (14bec31d) — Mac Anderson
- fix(cli): make current main green — reconcile the half-merged terminal-fold + live-status REPL (#410) (29302a1f) — Mac Anderson
- Fix/cli shell runner import and panel dupe (#407) (5d8ec272) — Mac Anderson
- fix(cli): repair the REPL render — restore cat-mouse chase + the dropped live-status stack (#406) (8ea1acb5) — Mac Anderson
- fix(cli): stop agent bash from hanging forever on timeout (#405) (46cdc2f3) — Mac Anderson
- Update README.md (ef953245) — Mac Anderson
- Update README.md (1eac3ef0) — Mac Anderson
- fix(tests): update stale opus→fable model slug assertions after catalog migration (#404) (2ff6cb7d) — Mac Anderson
- Feat/cli bang terminal panel (#403) (8cc163e9) — Mac Anderson
- feat(cli): arrow-key navigation of the REPL Agent Team / Task panels (#400) (add3f627) — Mac Anderson
- fix(cli): pin the REPL prompt bar to the bottom (full-screen TUI) (#401) (8501aebb) — Mac Anderson
- --no-verify (#402) (47a1bec1) — Mac Anderson
- feat(cli): pin REPL prompt bar to bottom-left with bottom-aligned agent panels (#399) (047658b8) — Mac Anderson
- test(cli): cover !command terminal panel + fix store.ts override modifiers (#398) (0af0bde5) — Mac Anderson
- fix(cli): repair REPL crash + get CLI package green (25f73f5c) — macanderson
- feat(cli): !command live terminal panel + verbose agent narration (9d002848) — macanderson
- save (57eb7e60) — macanderson
- save (b0c6fc13) — macanderson
- Feat/cli bang terminal panel (#397) (dcc87eac) — Mac Anderson
- feat(cli): Agent Team + Task Progress side panel in the REPL TUI (#396) (5620c891) — Mac Anderson
- feat(cli): Agent Team + Task Progress side panel in the REPL TUI (#395) (5463e168) — Mac Anderson
- feat(cli): ascii cat-and-mouse chase on the REPL status rail (#394) (ab7930c9) — Mac Anderson
- fix(cli): judge heuristic confidence + REPL cat-and-mouse whimsy (#393) (2330d818) — Mac Anderson
- fix(billing): dunning-sweep low-balance check fails for every org (no tenant scope) (#392) (618d6e25) — Mac Anderson
- fix: judge heuristic always returns 30/100 — wrong advisor model + hardcoded confidence (#391) (6b243805) — Mac Anderson
- fix(cli): silence benign AI SDK responseFormat warning (#390) (ca668028) — Mac Anderson
- feat(cli): latest-GA model defaults (single source of truth) + /hud running-agents view (#388) (4ccafe26) — Mac Anderson
- Fix/cli ci green repl tests (#389) (1b8af311) — Mac Anderson
- fix(agent): continue tool loop past first step in app chat; raise runaway backstop to 256 (46d6377e) — macanderson
- Feat/cli latest model defaults and hud (#387) (a69cb305) — Mac Anderson
- test(cli): replace flaky alt-screen frame guard with deterministic launchRepl test (#386) (0bdd6f52) — Mac Anderson
- fix(cli): interrupt (Esc) no longer wedges the prompt queue (#385) (a55f29e7) — Mac Anderson
- Fix/cli interrupt queue drain (#384) (b2fbebc6) — Mac Anderson
- fix(cli): honor settings.json Bash(*) allow in the interactive broker (#383) (b16f1318) — Mac Anderson
- fix(cli): stop duplicated REPL output (#382) (35966fcc) — Mac Anderson
- fix(cli): repair oxagen REPL launch (broken JSX + missing Message fields) (#381) (594c946d) — Mac Anderson
- feat(cli): graph-before-grep context layer + sync-embedding fix (pipeline Group 3) (#380) (b5567626) — Mac Anderson

## Oxagen v0.10.0

This release significantly overhauls the CLI's interactive REPL experience — introducing a full-screen TUI with live agent and task progress panels, a `!command` terminal panel for running shell commands inline, arrow-key panel navigation, a pinned prompt bar, and a new `/coordinator remote|local` command for switching to on-device GGUF inference. It also promotes the "precise" model tier from Opus to Fable, fixes several long-standing REPL stability bugs, and hardens the billing dunning sweep and judge heuristic.

### Features

- **`/coordinator remote|local` toggle** (`8ddd54fc`): New slash command switches the CLI coordinator between the metered platform gateway and a locally-loaded GGUF model (downloaded via `oxagen models pull`). The new `OnDeviceAgentAi` adapter (`apps/cli/src/agent/adapters/on-device-agent-ai.ts`) wraps the in-process GGUF runtime in the same AI SDK `streamText`/`generateObject` protocol used by the remote path — the tool loop is identical, only the backing model differs. Typed errors (`OptionalDepMissingError`, `NoFittingModelError`, `AutoDownloadDisabledError`) give developers actionable guidance when switching fails.

- **`!command` live terminal panel** (`9d002848`, `8cc163e9`): Prefixing a REPL input with `!` now spawns a live-updating terminal panel that streams the command's stdout/stderr in real time. The new `shell-runner.ts` (`ShellRunner`) manages the subprocess in its own process group, so timeouts kill the full subtree — not just the top-level `bash` shell. A new `PromptInputTerminal` component handles `!`-prefixed input and a dedicated `TerminalPanel` renders the output alongside the agent transcript.

- **Agent Team + Task Progress side panel** (`5463e168`, `5620c891`): The REPL TUI gains a right-hand sidebar (`agent-sidebar.tsx`) showing every registered agent (`AgentRegistry`) and its associated tasks (`TaskRegistry`) in real time. Panels are driven by the new process-wide `agentRegistry` singleton (`agent-registry.ts`) and `task-registry.ts`; producers register and patch entries via lightweight handles, while the sidebar subscribes to change events for live redraw.

- **Arrow-key panel navigation** (`add3f627`): Agents and tasks in the side panel are now navigable with the up/down arrow keys. Panel navigation state is managed independently of the main prompt, with `Escape` returning focus to the input bar.

- **Pinned prompt bar** (`8501aebb`, `047658b8`): The REPL prompt is now anchored to the bottom-left of the full-screen TUI, with agent panels aligned at the bottom so the layout is stable during long-running turns. A new `use-terminal-size.ts` hook tracks terminal dimensions and reflows the layout on resize.

- **`/hud` running-agents view** (`4ccafe26`): New `/hud` slash command renders a live heads-up display of all in-flight agents — turn, subagent, monitor, and fleet — sourced from `AgentRegistry`. Entries are sorted active-before-finished, finished entries linger for a configurable TTL (default 8 s), and then are pruned automatically.

- **ASCII cat-and-mouse animation on the REPL status rail** (`ab7930c9`): A small whimsical cat-and-mouse chase plays on the status rail while a turn is running. Set `OXAGEN_CLI_FUN=0` to disable it.

- **Latest-GA model defaults as a single source of truth** (`4ccafe26`): `model-catalog.ts` is the new canonical declaration of current model slugs for all families (Haiku, Sonnet, Fable, OpenAI coding). All tier defaults, the agent-loop default, the pipeline judge default, and the runtime `models.json` registry are derived from it — a new anti-drift test suite (`model-catalog.test.ts`) fails immediately if any source diverges.

- **Precise tier promoted from Opus → Fable** (`276e108e`): `modelForTier("precise")` now returns the Fable slug; `tierLabel("precise")` returns `"Fable"`. All tests, planner expectations, and the runtime registry have been updated accordingly.

- **`OXAGEN_CLI_FUN` and `OXAGEN_GRAPH_DISABLED` env vars**: Two new optional env vars documented in `.env.example`. `OXAGEN_CLI_FUN=0` disables the status-rail animation; `OXAGEN_GRAPH_DISABLED=1` bypasses the graph context layer and forces the grep fallback for the entire shell session.

- **App chat tool loop now continues past the first step** (`46d6377e`): `apps/app` chat stream route now passes `stopWhen: stepCountIs(256)` to `streamText`, matching the CLI and agent-engine defaults. Without this, the AI SDK's default `stopWhen: stepCountIs(1)` caused the app to halt after a tool call was issued — the model executed the tool but never received the result to compose a reply.

### Fixes

- **Agent bash no longer hangs forever on timeout** (`8a927a80`): `createCwdWorkspace` now delegates `exec` to `runShellCommandBuffered`, which runs commands in their own process group. The prior `execFile({ timeout })` only signalled the top-level `bash`, leaving grandchild processes holding the stdout pipe open indefinitely.

- **Duplicated REPL output eliminated** (`35966fcc`).

- **REPL crash on launch repaired** (`594c946d`, `25f73f5c`): Fixed broken JSX and missing `Message` fields that caused `oxagen` to crash on startup.

- **Interrupt (`Esc`) no longer wedges the prompt queue** (`a55f29e7`): Pressing Escape to cancel a turn previously left the queue in a drained-but-blocked state; subsequent prompts would silently queue but never execute.

- **`settings.json` `Bash(*)` allow now honoured in the interactive broker** (`b16f1318`): The permission broker was ignoring the `allow` list from `settings.json` in interactive sessions; commands that should have been auto-approved were incorrectly escalated to a prompt.

- **Billing dunning sweep fixed for multi-tenant orgs** (`618d6e25`): The low-balance check in `billing.dunning-sweep.ts` was applying without a tenant scope, causing it to fire (or skip) incorrectly for every org rather than being scoped per-organisation.

- **Judge heuristic confidence corrected** (`6b243805`, `2330d818`): The judge was hardcoding a 30/100 confidence score and using the wrong advisor model. It now uses the configured advisor and returns a meaningful confidence value.

- **AI SDK `responseFormat` warning silenced** (`ca668028`): A benign but noisy warning from the AI SDK about `responseFormat` was filtered in the REPL output layer.

- **`PanelTarget` export added to CLI public surface** (`276e108e`).

### Internal

- **`AgentRegistry`** (`agent-registry.ts`): Process-wide in-memory registry powering the `/hud`. Supports registration, patching, TTL-based pruning of finished entries, change subscriptions, and `remove()` for dismissing panel entries. Full test coverage in `agent-registry.test.ts`.

- **`TaskRegistry`** (`task-registry.ts`): Companion registry tracking task progress within a turn. Upserts by id without duplication, advances through `pending → in_progress → done/failed`, and exposes `finalizeOpen` and `clear`. Full test coverage in `task-registry.test.ts`.

- **`ShellRunner`** (`repl/shell-runner.ts`): Reusable shell subprocess manager with process-group isolation, timeout enforcement, stdout/stderr streaming, and `runShellCommandBuffered` for one-shot buffered execution. Test coverage in `shell-runner.test.ts`.

- **`use-terminal-size.ts`**: Ink hook that tracks terminal columns/rows and re-renders on `SIGWINCH`.

- **`double-press.ts`**: Utility for detecting double-key-press gestures (e.g. Ctrl-X twice to dismiss a panel entry).

- **`ai-warnings.ts`** (`lib/ai-warnings.ts`): Centralised filter for known-benign AI SDK warnings, with tests in `ai-warnings.test.ts`.

- **Deterministic REPL launch test** (`0bdd6f52`): Replaced a flaky alt-screen frame guard with a deterministic `launchRepl` integration test in `interactive.launch.test.tsx`.

- **Expanded test coverage**: New test files for panel navigation (`panel-nav.test.tsx`, `interactive.panel-nav.test.tsx`), interrupt-queue drain (`interactive.interrupt-drain.test.tsx`), terminal panel (`terminal-panel.test.tsx`), agent sidebar (`agent-sidebar.test.tsx`), HUD (`hud.test.tsx`), prompt input terminal (`prompt-input-terminal.test.tsx`), permissions broker `settings.json` rules (`permissions.test.ts` additions), model catalog anti-drift ratchet (`model-catalog.test.ts`), and tool timeout/throw logging (`timeouts.test.ts` additions). The old `scrollback.test.ts` (201 lines) was removed alongside the `scrollback.ts` module it covered.

## v0.9.0

This release ships the **graph-before-grep context layer** (pipeline Group 3): the CLI agent now queries the local code graph — fusing structural traversal and optional semantic embedding — before falling back to a grep scan. Every fallback is logged with its reason. The release also fixes a sync-embedding bug in the code-graph store and adds the `graph push` command to ship locally-computed vectors to the server.

### Features

- **Graph-before-grep context resolver** (`b5567626`): `GraphContextResolver` is the new default context path for the CLI agent. It queries the code graph first; if coverage clears the 0.15 threshold the structured result (impacted files, symbols, edges) is returned directly. A miss — graph disabled, empty graph, or low coverage — falls back to grep (or fails closed when `fallbackToGrep: false`). Every decision is logged as a structured `[graph] hit` or `[graph] fallback=grep reason="…"` event.

- **`graph_query` core** (`apps/cli/src/agent/context/graph-query.ts`): fuses two signals per query — semantic cosine ranking of file nodes against the query embedding and structural seed-symbol expansion with configurable hop depth and call-flow direction (`callers` / `callees` / `both`). Returns `{ impactedFiles, symbols, edges, coverage, source }`. Benchmarks confirm a single `graph_query` call replaces ≥ 50 % of the grep/read/glob calls a baseline agent would issue (75 % across the three representative scenarios in the test suite).

- **Semantic index** (`apps/cli/src/agent/context/semantic-index.ts`): lazily embeds file nodes using `text-embedding-3-small` (1536-d) via the Vercel AI Gateway, persists vectors through the `CodeGraphStore`, and reuses them on subsequent queries. Nodes whose `embeddingProvider` no longer matches the active client are automatically re-embedded.

- **`GatewayEmbeddingClient`** (`apps/cli/src/agent/context/embedding.ts`): wraps the AI SDK `embed` / `embedMany` calls against the shared gateway model. Returns `null` (logged degradation, no error) when no gateway key is available; the resolver continues with structural-only context. New `OXAGEN_GRAPH_DISABLED` env var (`1` or `true`) bypasses the graph for an entire shell session and forces the grep fallback.

- **Grep fallback scanner** (`apps/cli/src/agent/context/grep-fallback.ts`): bounded async walk (≤ 4 000 files, ≤ 50 results) that skips `node_modules`, `.git`, `dist`, `.next`, and similar dirs, ranks files by lexical hit count, and returns `ImpactedFileRef[]`. Runs only on a graph miss.

- **Graph traversal primitives** (`apps/cli/src/agent/context/traversal.ts`): `tokenize` (camelCase splitting, noise-token removal), `resolveSeeds` (name-anchor symbols from query or `focusSymbols`), `expandNeighbourhood` (BFS up to `maxNodes`), and `callFlow` (directed caller/callee walk).

- **Context formatters** (`apps/cli/src/agent/context/format.ts`): `formatGraphResultJson` (the exact JSON payload the `graph_query` tool returns) and `formatGraphContextForPrompt` (compact human-readable block injected into worker prompts). Both are derived from the same `GraphResult` so the tool output and prompt context cannot drift.

- **`graph push` command** (`apps/cli/src/commands/graph.push.ts`, `packages/handlers/src/graph.sync.push.ts`): new CLI command and server-side handler that ship locally-computed node embeddings to the platform, avoiding a redundant server re-embed. Covered by a new `graph.sync.push` contract in `packages/oxagen`.

- **`@oxagen/code-graph` embed helpers** (`packages/code-graph/src/embed.ts`): exports `CODE_EMBED_DIM`, `CODE_EMBED_GATEWAY_MODEL`, `renderFileText`, and `renderSymbolText` — the shared rendering and dimension constants used by both the CLI embedding client and the server ingestion pipeline, keeping vector spaces compatible.

- **`@ai-sdk/gateway` dependency** added to `apps/cli` for gateway-backed embedding.

### Fixes

- **Sync-embedding bug in `CodeGraphStore`** (`apps/cli/src/daemon/code-graph/store.ts`, `b5567626`): fixed an issue where `updateNodeEmbeddings` was not correctly persisting vectors written during the sync path, causing redundant re-embedding on subsequent resolver calls. The store now batches and commits vectors atomically; the new `store.embeddings.test.ts` covers the regression.

- **GitHub-parse-file ingestion** (`packages/ingestion/src/functions/ingestion.github-parse-file.ts`): updated to handle the richer `CodeNode` type introduced by the embedding additions (new `embeddingProvider` and `embedding` fields on `code-graph/types.ts`).

### Internal

- **Full test suite for the context layer** (514 + lines across five new test files): `context.test.ts` covers config merging, traversal, the semantic index, `runGraphQuery`, `GraphContextResolver`, formatters, and embedding-client resolution; `embedding.test.ts` covers `GatewayEmbeddingClient` with mocked AI SDK calls; `grep-fallback.test.ts` covers the scanner against a real temp dir; `benchmark.test.ts` asserts the ≥ 50 % tool-call reduction; shared fixtures in `fixtures.ts`.

- **Graph config slice** (`apps/cli/src/agent/context/config.ts`): `mergeGraphConfig` / `readGraphConfig` with `OXAGEN_GRAPH_DISABLED` env override; `MIN_COVERAGE = 0.15` constant shared between the resolver and tests.

- **Config registry** (`packages/config/src/registry.ts`): added `graph` key for the new config slice.

- **Public surface** re-exported from `apps/cli/src/agent/context/index.ts`; `apps/cli/src/agent/tools.ts` wires the `graph_query` tool into the agent tool registry.

## What's new in v0.8.0

This is the largest release since the project began. v0.8.0 delivers a full-featured CLI (authentication, REPL, pipeline, on-device models, cost tracking), a new two-axis memory model, browser automation and durable sandbox capabilities, agentic GitHub write support, a redesigned UI and marketing site, a comprehensive benchmark suite, and a brand-new `@oxagen/agent-engine` shared package — all accompanied by a major expansion of the contract, test, and observability infrastructure across the monorepo.

---

### Features

#### CLI — REPL & UX
- **Beautiful, scannable REPL output** with a permanently pinned input + status bar glued to the bottom of the terminal (`235ed76c`, `3e27f4ac`).
- **History scrollback** (`58e77146`) and **themed diff view** with syntax highlighting (`29bb0dfe`, `diff-view.tsx`).
- **Slash-command typeahead menu** and `/tui` fullscreen toggle (`d8fbd458`, `3c18d2ea`).
- **Agent observability status line**: reasoning effort, per-call timeouts with ETA indicator, cache/cost status, and permissions UX (`4d7fcc83`, `58e77146`).
- **`🏋️` pipeline-activated indicator** in the status line when the orchestration pipeline is running (`a5a7cfb0`).
- Agent now correctly interprets tool results and reports a real terminal status instead of silently succeeding (`63688f52`).
- Esc-twice reset confirmation is now handled synchronously (`52d4ac1d`); `/init` hang on gitignore + log spam fixed (`9249978b`).
- REPL transcript rendered via `<Static>` with alternate-screen dropped for cleaner scroll behaviour (`29bb0dfe`).

#### CLI — Authentication & Workspace
- **`oxagen login`** with browser loopback OAuth (PKCE + single-use code store) and a tenant/workspace picker (`df4aac2d`, `66f1ffeb`, `8008798e`).
- **`oxagen init` / `/init`**: scaffold `.oxagen/` settings, build a local code graph, print stats and domain summary (`f100e58f`).
- **Workspace linker** (`.oxagen/workspace.json`) and global settings at `~/.oxagen/` with Claude Code parity (`290b92b2`, `53dc8730`).
- **`oxagen logs`**: stream the `OXAGEN_CLI_DEBUG` file log for live debugging (`02d37313`).
- Enterprise prompt-override unlock and Esc stop/reset (`9249978b`).

#### CLI — Pipeline & Orchestration
- **On-device model runtime + auto-provisioning** (`dd35f097`): download and run local models with automatic provisioning.
- **Orchestrator + cross-vendor model routing** (`2a1d629f`): OpenAI advisor, evaluator-chosen worker model, `oxagen models` command.
- **Pipeline state machine + verification + observability** (`043ea464`): typed contracts surface, background agent-to-agent monitors, assist/review tools (`prompt_enhancer`, `judge`, `user_survey`).
- **`oxagen cost`**: structured session telemetry, baked-in rate card, verbose mode (`9c9943f0`, `179 + lines`).
- **`oxagen memory import`**: bulk-import skill files as graph memories with an editable grid (`f3ee301e`).

#### CLI — Code Graph
- **`graph push` / `graph pull` / `graph lineage`**: bidirectional CLI ↔ workspace graph sync (ADR-018), local DuckDB replica (`5d623155`, `a78aea01`).
- **Unified tree-sitter builder** shared between ingestion and CLI (`290e9a8c`).
- `CALLS` + cross-package `IMPORTS` edges (execution flows) and LLM domain inference on code-graph nodes (`b260428b`, `2b1cf066`).
- Commits linked to `SourceFile` via `:MODIFIED` edges for recent-changes graph queries (`9401769a`).
- Structured `code_map` agent tool (graph-before-grep) (`832359c2`).
- Code graph persisted to DuckDB and synced via the daemon (`8677699f`).

#### Agent Engine — New Shared Package
- **`@oxagen/agent-engine`** (`e60f573c`): unified brain module shared by CLI and in-app agent, covering fleet, pipeline, planner, router, tools, ports, and workspaces. ADR-019.
- In-app `agent.repo.edit` capability runs the full `runTurn` pipeline, opening a PR against a connected repo (`7709271b`, `fa5b0839`).

#### Memory — Two-Axis Model
- **Two-axis memory model** (`2ef0e747`): `OBSERVATION → RULE → FACT` taxonomy with confidence scores and enforcement levels.
- **Complete two-axis migration** across app UI, auto-cite, and tests (`4c2f2415`).
- **Bulk-import** skill files as graph memories from the web UI and CLI (`f3ee301e`).
- Full `agent.memory.*` capability suite: `remember`, `update`, `delete`, `list`, `cite`, `promote`, `evidence.attach`, `import.parse`, `import.commit`, `promotion.candidates`, `citations.list` — wired through MCP, API, and handlers.

#### Durable Sandboxes & Browser Automation
- **`agent.sandbox.*`** capabilities: `start`, `exec`, `snapshot`, `stop` — durable Modal-backed sandbox sessions with a local shim (`5fc8cbe9`, `ad4b9d91`).
- **`browser.*`** capabilities: `navigate`, `fill`, `submit`, `click`, `read`, `screenshot`, `refresh` — drives a Playwright browser inside the durable sandbox (`d6b0275b`, `59b20fe4`).
- **Playwright + `browserctl`** pre-installed in the durable agent image (`0be7ea6c`).
- **`agent.feature.verify`**: cross-LLM judge verifies a visible feature using browser screenshots from a *different* vendor than the builder (`ea47a23b`, `3ca09018`).
- **`feature-browser-proof` skill**: definition-of-done loop — sandbox → build → browser → screenshot → independent verdict.

#### GitHub Write & Repo Capabilities
- **`agent.repo.edit`**: agent edits a connected repo and opens a PR (`7709271b`).
- **Per-workspace GitHub token resolution** (ADR-020): App installation tokens with OAuth fallback (`f62c5d69`).
- **`/github/setup` landing route** for App reconfigure redirect (`aabfd26c`).
- Repo capabilities: `repo.create`, `repo.fork`, `repo.branch.create`, `repo.file.put`, `repo.pr.open`.
- GitHub App workspace settings page and GitHub connection settings UI (`1365d172`, `358`+).

#### App — UI & Workspace
- **Oxagen Tangerine palette** (`0c963b5b`): tangerine/rose/teak/narwhal design tokens.
- **Docs-parity visual system** — ember hero, gradient/outline CTAs, wordmark headings (`f468db0d`).
- **Shared markdown editor**, read-only renderer, and truncate-popover primitives (`08904994`).
- **Environments & Secrets vault UI** with paste-`.env` bulk import (`0639b28f`).
- **In-app agentic coding**: repo/env selector, CI monitor, PR inspection card (`b2fe700b`).
- In-app agent drawer conversations are now persisted (`0a260319`).
- P0 fix: `TabsPanel` content is now scrollable (marketplace MCP server list was clipped) (`c173d048`).
- Automation/Activity preview pages and stale Integrations nav removed (`d218e0a7`).

#### Benchmarking
- **`@oxagen/bench-web`** (`99d1bed4`): Next.js eval dashboard launched via `pnpm eval:app`.
- **SWE-bench** multi-vendor runner with a trustworthy real-data dashboard (`2555efbb`).
- **Terminal-Bench (Harbor)** adapter for the Oxagen CLI (`84f54a01`).
- **Context-quality eval gate** with RAGAS/DeepEval bridge; warm/self-improvement variants (`092fd6e3`, `bc09553f`).
- **ClickHouse eval-results protocol** (`eval_runs` + `eval_results` tables) (`f7fafe85`).
- One-command runner + ClickHouse ingestion for eval results (`e23be06e`).

#### API, MCP & Contracts
- New REST routes and MCP tools for every capability listed above (sandbox, browser, memory, repo, graph, org, workspace).
- **`GET /v1/auth/whoami`** credential probe to unblock CLI API-key login (`eb8a5178`).
- **`auth.cli.token`** loopback OAuth token endpoint (`auth.cli.token.ts`).
- **`plugin.catalog.sync`** REST route (`728438c2`).
- `org.list` and `workspace.list` capabilities wired end-to-end (`1758a183`, `296`+).
- **Regenerated contract barrel** restoring 19 dead capabilities (`agent.memory.delete` et al.) (`ad1a38ba`).
- **`apps/schemas`**: new package hosting `oxagen-cli-settings-schema.json` at `schemas.oxagen.sh` (`0a328134`).

#### Docs
- **Full CLI documentation** (`docs/cli/`): installation, account setup, quickstart, commands reference, configuration, knowledge graph, models (`bfe2e51d`, `#336`+).
- Marketing landing page with 109 accuracy fixes from a full apps/docs audit (`a142ac4d`).
- ADR-018 (bidirectional graph sync), ADR-019 (unified agent engine), ADR-020 (per-workspace GitHub credentials).
- Capability reference pages for all new `browser.*`, `agent.sandbox.*`, `agent.memory.*`, `repo.*`, `graph.*`, and `code.map` capabilities.

---

### Fixes

- **CLI**: agent must interpret tool results and report a real status — was silently reporting success on tool errors (`63688f52`).
- **CLI**: pretty tool-call output + agent observability follow-ons (`a265d7e1`).
- **CLI**: global settings tier at `~/.oxagen/` (home-dir, Claude Code parity) (`290b92b2`).
- **CLI**: `/init` hang on gitignore write + log spam (`9249978b`).
- **CLI**: Esc-twice reset confirmation now synchronous, was queued as a prompt (`52d4ac1d`).
- **CLI**: close session-memory handle when REPL unmounts mid-open (`bfd9e6a0`).
- **CLI**: bind `err` in login picker-failure catch, fixing ReferenceError (`1226afad`).
- **CLI**: graph push must label symbols `:SourceSymbol`, not `:Symbol` (`de4e1fd6`).
- **CLI**: publish standalone bundle from `release.ts` to drop `workspace:*` leak (`a2bd4b57`).
- **IAM**: org owner is now a super-user — never locked out by un-seeded capability (`ed6fc2c2`).
- **IAM**: API keys authorise as their creator on enterprise orgs (`a9fc062d`).
- **IAM**: resolve API keys by fixed 12-char prefix window, not `_` split (`73f28dfc`).
- **Auth**: forward `stopWhen` + `onError` through `streamAgentReply` (`6bd2c8da`).
- **Graph**: enforce PascalCase node labels everywhere + descriptive inferred nodes (`93abe34a`).
- **Graph**: type inferred edges descriptively, not as `:SEMANTIC_EDGE` (`66474030`).
- **Graph explorer**: wire create-node/edge dialog vocab + serialise Neo4j reads (`aa8999a8`).
- **Graph**: unblock knowledge-graph explorer — accept all explore ops + serialise reads (`b08db8c4`).
- **Ontology**: idempotent Neo4j migrate over duplicate-`publicId` legacy `KnowledgeNodes` (`4afa3d36`).
- **MCP**: register `org.list` + `workspace.list` tools for contract parity (`35968b44`).
- **Memory**: wire `agent.memory.list` end-to-end + point Memories tab at Neo4j (`c6f5ffc0`).
- **App**: repair broken import + remove duplicate `KIND_CONFIG` (`00ef997b`).
- **App**: restore broken Memory settings page + remove stale Integrations page (`1d461c01`).
- **App**: schema-builder Storybook stories 404 — serve fixtures, not live API (`398d660d`).
- **API**: `repo.create` org is optional (stale test + lint) (`0b0152ec`).
- **API**: guard module-scope `fileURLToPath` in skill handlers (was causing `FUNCTION_INVOCATION_FAILED`) (`34ff931a`).
- **GitHub**: fallback to OAuth token when GitHub App token minting fails (`dca716f7`).
- **GitHub source wizard**: didn't advance after install — Setup-URL leg dropped connection (`ebc00ae9`).
- **GitHub**: drop `.js` import extensions for Turbopack resolution (`4a6b6316`).
- **Schema-builder**: widen label/relationship dialogs + rebalance properties grid (`683fb57a`).
- **Schemas**: regenerate CLI settings schema for `effort` field, unblocking main CI (`27aaaf81`).
- **Bench**: make `pnpm eval:app` resilient to a busy port (`f0470f37`).
- **Docs**: `HexField` re-export moved into the whitelisted UI layer (`b0b10e84`).
- **UI**: scrollable `TabsPanel` content — marketplace MCP server list was clipped (`c173d048`).
- **CI**: optimise `turbo.json` for parallelisation and cache efficiency (`eb96f3af`).
- **CI**: app build/typecheck Node heap raised to 8 GB to fix cold-build OOM (`62431335`).
- **Perf**: parallelise independent async I/O operations across handlers (`d585887b`).
- **Agent**: raise timeout on lazy-import registry tests to fix CI flake (`fd384ef1`).
- **Agent-engine**: use extensionless relative imports (Turbopack can't resolve `.js` → `.ts`) (`ff0b5299`).
- **Database**: register `agent.sandbox_sessions` in RLS `POLICY_MANIFEST` (`6a3d3e1b`).
- **RLS/CLI**: add `workspace.workspace_memory_policy` to manifest + fix lint (`2c4e55be`).
- **Contracts**: dedupe duplicate `graphExport` export blocking CI (`cd7bc1a8`).
- **Shell**: suppress agent bar in workspace-less sections (`1ae961b4`).

---

### Internal

- **New `@oxagen/agent-engine` package** consolidates CLI brain modules (A4/A5/A6/A7) into a shared, platform-routed package (ADR-019) (`1f85130d`, `e60f573c`).
- **New `@oxagen/code-graph` package**: unified tree-sitter parser + domain inference shared by CLI and ingestion (`290e9a8c`).
- **New `@oxagen/github` package**: `fetch-client`, `app-auth`, `github-workspace` with full test coverage.
- **New `@oxagen/sandbox` package**: Modal durable sandbox driver + local shim types.
- **`apps/schemas`**: publishes `oxagen-cli-settings-schema.json` to `schemas.oxagen.sh`.
- **`bench/`**: four new benchmark suites — `swe-bench`, `terminal-bench`, `context-eval`, `rag-eval`, each with Python harness, data ingestion, and `bench/web` dashboard.
- **Database**: `agent_sandbox_sessions` table, `workspace_memory_policy` migration, two-axis memory enforcement column (`20260628*` migrations).
- **Telemetry**: ClickHouse `eval_runs`/`eval_results` tables + migration runner with full test coverage (`f7fafe85`).
- **Inngest**: `ingestion.github-commit-files`, `ingestion.github-infer-domains`, `auth.session-expiry-audit`, `engram.*` consolidation, and `memory.decay-pass` functions added/expanded.
- **Coverage gates**: database raised to 85% lines; `agent-engine`, `auth`, `handlers`, `ingestion`, `plugins`, `ontology`, `telemetry` all gain substantial new test suites. `skills-lock.json` removed (`a509856e`).
- **`tools/scripts`**: `run-evals.ts`, `eval-ingest.ts`, `preflight-ports.ts`, `lib/eval-protocol.ts`, `lib/dev-log-shipper.ts` added; `pnpm dev` now pre-flights ports to avoid crash when the stack is already running (`04d944b7`).
- **Turbo**: exclude test files from build inputs; checks timeout raised 20 m → 60 m for cold-cache PRs.

## What's new in v0.7.0

This is the largest release in Oxagen's history, touching nearly every layer of the platform. The headline additions are: a fully-featured CLI agent with an on-device model runtime, a multi-vendor pipeline with per-call timeouts and live metrics, a two-axis memory model (OBSERVATION → RULE → FACT with confidence and enforcement), durable sandbox browser automation, an independent cross-LLM feature-verification judge, and a brand-new benchmark suite with a real-data dashboard. The web app gains a complete Environments & Secrets vault, GitHub App workspace integration, a redesigned Oxagen Tangerine palette, and shared markdown editor primitives. Dozens of API/MCP capabilities were wired end-to-end, a new `@oxagen/agent-engine` shared package was extracted, and the monorepo now ships hosted JSON Schema for CLI settings.

---

### Features

#### CLI agent & REPL
- **Beautiful, scannable REPL output** — messages, tool calls, and statuses are now formatted for readability in the terminal (`235ed76c`, #378).
- **Pinned bottom layout** — input and status bar are always glued to the bottom of the terminal; transcript scrolls above using `<Static>` rendering, eliminating the alternate-screen flicker (`29bb0dfe`, `3e27f4ac`, #374, #347).
- **History scrollback** — the REPL now supports scrollback through previous turns (`58e77146`, #376).
- **Themed diffs** — file-change diffs are rendered with syntax colouring in the terminal (`58e77146`, #376).
- **Slash-command typeahead menu** — `/` in the REPL shows a filterable list of all available slash commands with descriptions (`d8fbd458`, #283).
- **`/tui` fullscreen toggle** — switch between fullscreen and inline REPL modes at will (#283).
- **`oxagen init` / `/init`** — scaffolds `.oxagen` settings, builds the local code graph, and prints stats and domain breakdown (`f100e58f`, #281).
- **`oxagen login`** — browser-based PKCE loopback OAuth with a tenant/workspace picker; persists workspace link in `.oxagen/workspace.json` (`df4aac2d`, `66f1ffeb`, `53dc8730`, #265, #308, #295).
- **`oxagen logs`** — streams or dumps the `OXAGEN_CLI_DEBUG` file log (`02d37313`, #338).
- **`oxagen cost`** — shows per-session cost broken down by model, cached vs. uncached tokens (`9c9943f0`, #211).
- **Esc-to-stop / Esc-to-reset** — pressing Esc once stops the agent; pressing Esc twice shows a reset confirmation handled synchronously (`52d4ac1d`, #352).
- **Pipeline activated indicator** — a 🏋️ icon appears in the status line whenever the pipeline is engaged (`a5a7cfb0`, #373).
- **Agent turn timeouts + ETA indicator** — per-call configurable timeouts surface estimated time remaining in the status line (`edb8be29`, `58e77146`, #321, #376).
- **Live status metrics** — cache hit rate, cost, and token counts update in the status bar during a turn (`58e77146`, #376).
- **Agent observability** — reasoning traces, effort level, cache/cost status, and permissions UX are all surfaced in the REPL (`4d7fcc83`, `05bf6ecc`, #346, #343).
- **Pretty tool-call output** — tool invocations and results are formatted as scannable cards rather than raw JSON (`a265a9d1`, #342).
- **Agent correctly interprets tool results** — the agent now reads tool results and derives a real exit status instead of always reporting success (`63688f52`, #379).

#### CLI pipeline
- **Multi-vendor orchestrator and model routing** — a routing-policy JSON file directs different turn types to different model providers; an OpenAI evaluator can score outputs from another vendor (`708f9730`, `2a1d629f`, #228, #368).
- **On-device model runtime with auto-provisioning** — the CLI can run models locally; missing model weights are downloaded and quantized automatically (`dd35f097`, #366).
- **Assist + review tools** — `prompt_enhancer`, `judge`, and `user_survey` pipeline tools are available to every agent turn (`c2f61187`, #369).
- **Background agent-to-agent monitors** — long-running monitors can spawn sub-agents and relay their outputs back to the REPL (`266eae7e`, #372).
- **Typed pipeline contracts** — all pipeline I/O is validated against typed schemas at runtime (`8701dfa1`, #371).
- **Pipeline state machine + verification + observability** — a formal state machine governs turn lifecycle; each state transition is logged and observable (`043ea464`, #375).

#### CLI commands & settings
- **`oxagen models`** — lists available models and their routing configuration.
- **`oxagen rules`** — manages workspace-scoped agent rules.
- **`oxagen settings`** — reads and writes the unified `settings.json` driver (env, model, permissions, hooks) (`4281e9c7`, #212).
- **`oxagen memory import`** — bulk-imports skill files as graph memories via an editable grid (#333).
- **`oxagen graph push/pull/lineage/status`** — bidirectional CLI↔workspace graph sync (ADR-018); `graph.lineage` shows execution lineage.
- **`oxagen mcp`** — manages MCP server configuration from the CLI.
- **Global settings at `~/.oxagen/`** — home-directory settings file follows Claude Code parity (`290b92b2`, #282).
- **Hosted CLI settings JSON Schema** — `oxagen-cli-settings-schema.json` is published at `schemas.oxagen.sh` for editor validation (`0a328134`, #339).

#### Unified agent engine (`@oxagen/agent-engine`)
- New shared `@oxagen/agent-engine` package consolidates the agent brain (loop, planner, model router, rate card, fleet memory, evaluator, judge, prompt enhancer) so the CLI, in-app agent, and API all run identical logic (ADR-019, `e60f573c`, #284).
- Platform port adapters wire the engine to Neo4j memory, the code graph, trace store, and AI routing (`09f25002`, `1f85130d`, #267).

#### Memory
- **Two-axis memory model** — memories are now typed as OBSERVATION → RULE → FACT with a `confidence` score and an `enforcement` level (`2ef0e747`, `4c2f2415`, #357, #361).
- **Full memory CRUD** — `agent.memory.remember`, `agent.memory.update`, `agent.memory.delete`, `agent.memory.list`, `agent.memory.cite`, `agent.memory.promote`, `agent.memory.promotion.candidates`, `agent.memory.import.parse`, `agent.memory.import.commit`, `agent.memory.evidence.attach`, `agent.memory.citations.list` all wired through contracts → MCP → API → Neo4j handlers.
- **Auto-cite in chat** — the in-app agent automatically cites memories it uses when generating a response.
- **Bulk import** — the Memories tab gains an editable grid for importing memories from skill files, with a `memories-bulk-import` E2E spec (#333).
- **Memory list wired to Neo4j** — the Memories tab now queries Neo4j instead of the legacy store (#237).

#### Code graph & ingestion
- New `@oxagen/code-graph` package — unified tree-sitter builder shared by ingestion and the CLI (`290e9a8c`, #274).
- **LLM domain inference** — each code-graph node gets a `domain` property inferred by an LLM (`2b1cf066`, #278).
- **CALLS + cross-package IMPORTS edges** — execution-flow edges are now captured (`b260428b`, #280).
- **Commit → SourceFile `:MODIFIED` edges** — recent-change graph queries now work (`9401769a`, #277).
- **`code.map` capability** — structured code-map retrieval for use as a graph-before-grep agent tool (`832359c2`, #276).
- **`:TOUCHED_FILE` edges** — the in-app agent records which files it reads or edits (`5e7af08f`, #279).
- **`graph.sync.push` + CLI code-delta up-sync** — CLI pushes local graph deltas to the platform (ADR-018 slices 2–3).
- **Execution lineage** — `graph.lineage` and `:EXECUTION_STEP` edges track agent turn history.

#### Durable sandboxes & browser automation
- **`agent.sandbox.*`** — `start`, `exec`, `snapshot`, `stop` capabilities provision durable Modal sandbox sessions with Playwright pre-installed (`5fc8cbe9`, `ad4b9d91`, `b9c1aea1`).
- **`browser.*`** — `navigate`, `fill`, `submit`, `click`, `read`, `screenshot`, `refresh` capabilities drive a browser inside the durable sandbox (`d6b0275b`, `59b20fe4`).
- **`agent.feature.verify`** — cross-LLM judge surface: a different-vendor vision model reads screenshots from the sandbox browser and produces a pass/fail verdict against a requirement (`ea47a23b`, `3ca39018`).
- **`feature-browser-proof` skill** — formalises the definition-of-done loop using sandbox + browser + judge; agents must run it before declaring a visible feature complete.

#### GitHub & repo capabilities
- **GitHub App workspace integration** — per-workspace App installation tokens with OAuth fallback (ADR-020); settings page lets workspace admins connect or reconfigure (`f62c5d69`, `1365d172`, #300).
- **`agent.repo.edit`** — the agent engine can edit a connected repo and open a PR (`7709271b`, #268).
- **`repo.*` capabilities** — `repo.create`, `repo.fork`, `repo.branch.create`, `repo.file.put`, `repo.pr.open` all wired through contracts → API → GitHub handler.
- **`/github/setup` landing route** — handles post-install redirect from GitHub App configuration (`aabfd26c`).

#### Web app
- **Oxagen Tangerine palette** — the entire app is re-themed to tangerine/rose/teak/narwhal (`0c963b5b`, #359).
- **Docs-parity visual system** — ember hero section, gradient/outline CTAs, wordmark headings matching the marketing site (`f468db0d`, #355).
- **Environments & Secrets vault** — full CRUD UI for workspace environment variables with bulk `.env` paste import (`0639b28f`, #215).
- **GitHub settings page** — dedicated GitHub connection settings panel for workspace admins (`1365d172`, #300).
- **Shared markdown editor, read-only renderer, and truncate-popover** — reusable `markdown-code-editor`, `markdown-content`, and `truncated-text` primitives used across the app (`08904994`, `350`).
- **CLI OAuth consent page** — `/cli/authorize` handles the PKCE loopback OAuth flow with a consent form (`auth.cli.token.ts`, `consent-form.tsx`).
- **In-app agentic chat** — foundational components for repo/env selection and CI monitoring added to the chat panel (`b2fe700b`, #314).
- **PR inspection card** — the chat panel can render pull-request summaries inline.
- **Conversations persisted** — in-app agent drawer conversations are now persisted across page navigations (#223).

#### Benchmark suite
- New `bench/` workspace with four runners: **context-eval** (repo-grounded Q&A, oxagen vs Claude Code), **RAG-eval** (RAGAS/DeepEval), **SWE-bench** (multi-vendor verified harness), **Terminal-Bench / Harbor** adapter for the Oxagen CLI (`1e65ef7a`, `84f54a01`, `2555efbb`, `f591efca`, #316, #234, #340).
- **`bench/web` (`oxagen.eval.harness`)** — Next.js dashboard that renders real benchmark data with charts and methodology detail (`fd2494ef`, `9fb8e184`, #341, #337).
- **ClickHouse eval-results ingestion** — `eval_runs` + `eval_results` tables; `tools/scripts/eval-ingest.ts` ships results from CI (`f7fafe85`).
- **`pnpm eval:app`** — single command to launch the benchmark dashboard, resilient to a busy port.

#### API & MCP
- **`GET /v1/auth/whoami`** — credential probe endpoint used by CLI API-key login (`eb8a5178`, #293).
- **`auth.cli.token`** — PKCE single-use code store backing the CLI loopback OAuth flow (`8008798e`, #290).
- **`org.list` + `workspace.list`** — listed and registered in MCP tool registry and API (`1758a183`, `b54e6c51`).
- **`plugin.catalog.sync`** — REST route + contract test wired (#238).
- **`graph.export`** — exports a workspace graph snapshot for CLI down-sync.
- **IAM: org owner is a super-user** — org owners are never locked out by an un-seeded capability (`ed6fc2c2`, #322).
- **API keys authorize as their creator** — fixes fail-closed behaviour on enterprise orgs (`a9fc062d`, #297).
- Parallelized independent async I/O operations in several handlers for improved latency (`d585887b`, #303).

#### Docs
- Full **CLI guide** (`docs/cli/`) — installation, account setup, commands, knowledge-graph reference, configuration, quickstart (`bfe2e51d`).
- ADR-018 (CLI↔workspace graph sync), ADR-019 (unified agent engine), ADR-020 (per-workspace GitHub credentials) published.
- `browser.*` capability reference pages + capability index updated.
- Marketing landing page shipped with 109 accuracy corrections from a full docs audit (`a142ac4d`, #336).

---

### Fixes

- **REPL transcript via `<Static>`** — drops the alternate screen, so output is preserved in the terminal scrollback after the session ends (`29bb0dfe`, #374).
- **Esc-twice reset confirmation** handled synchronously (was previously queued as a prompt and could be missed) (`52d4ac1d`, #352).
- **Agent tool-result interpretation** — the agent now reads tool results before reporting a status; previously it could report success regardless of the tool's output (`63688f52`, #379).
- **`HexField` re-export** moved into the whitelisted UI layer in both docs and app to fix Storybook 404s (`b0b10e84`, `5462657f`, #377, #370).
- **Graph explorer** — fixed create-node/edge dialog vocabulary, serialised Neo4j reads in scoped sessions, PascalCase node label enforcement everywhere (`aa8999a8`, `93abe34a`, `b08db6c4`, #327, #313).
- **Knowledge graph explorer** — accepts all explore ops and serialises Neo4j reads so the explorer no longer deadlocks (`b08db6c4`, #326).
- **Stale contract barrel** — regenerated; 19 capabilities (`agent.memory.delete` et al.) were dead at runtime (`ad1a38ba`, #323).
- **`/init` hang** — fixed gitignore parsing and log spam that caused `oxagen init` to stall; also fixed the Esc stop/reset flow and Enterprise prompt-override unlock (`9249978b`, #317).
- **CLI loopback login** — bound `err` variable in login picker-failure catch to fix a `ReferenceError` (`1226afad`, #312).
- **CLI API endpoint paths** — removed a double `user/` prefix in the linker (`f2cfa54a`, #307).
- **CLI session-memory handle** — closed the session-memory file handle when the REPL unmounts mid-open to prevent a resource leak (`bfd9e6a0`, #272).
- **`repo.create` personal-account repos** — fixed a 404 when creating a repo under a personal GitHub account (`ce4904d2`, #294).
- **Schema-builder dialogs** — widened label/relationship dialogs and rebalanced the properties grid (`683fb57a`, #356).
- **TabsPanel scroll** — P0 fix: scrollable `TabsPanel` content (marketplace MCP server list was clipped) (`c173d048`, #348).
- **Memory settings page** — repaired the broken import that rendered the page blank (#302).
- **GitHub source wizard** — fixed the Setup-URL leg that dropped the connection after install (`ebc00ae9`, #269).
- **`agent-engine` extensionless relative imports** — Turbopack could not resolve `.js` → `.ts` mappings; fixed by dropping the extension (`ff0b5299`, #273).
- **Schema CLI settings schema** — regenerated for the `effort` field to unblock main CI (`27aaaf81`, #367).
- **`app` broken import + duplicate `KIND_CONFIG`** — repaired to unblock CI (`00ef997b`, #365).
- **Turbo cache** — optimised `turbo.json` for parallelisation and cache efficiency; CI checks timeout raised from 20 min to 60 min for cold-cache PRs (`eb96f3af`, #304).
- **App build OOM** — raised Node heap to 8 GB for CI cold builds (`62431335`).
- **`api` module-scope `fileURLToPath`** — guarded to prevent `FUNCTION_INVOCATION_FAILED` taking the whole API down (`34ff931a`, #258).
- **API key prefix resolution** — fixed to use a fixed 12-char prefix window instead of splitting on `_` (`73f28dfc`, #289).
- **IAM fetch-authz** — org owner is now treated as a super-user; fixes lockout on enterprise orgs (`ed6fc2c2`, #322).
- **`pnpm dev` pre-flight** — app ports are checked before startup so the dev server no longer crashes when the stack is already running (`04d944b7`, #217).
- **`eval:app` port conflict** — `pnpm eval:app` is now resilient to a busy port (`f0470f37`, #335).
- **GitHub `@oxagen/github` package** — migrated from Octokit to native fetch so Turbopack can build the Next.js app (`3fadbb85`, #240).
- **Duplicate `graphExport` export** — deduplicated to unblock main CI (`cd7bc1a8`, #229).

---

### Internal

- **Removed Automation/Activity pages and all preview/placeholder pages** — simplifies the app surface and eliminates dead routes (`d218e0a7`, #351).
- **Removed Integrations nav/page** — replaced by per-capability settings tabs (`8a79f497`, #305, #306).
- **`@oxagen/github` package** — new package encapsulating GitHub App auth, fetch client, and workspace token resolution; replaces scattered Octokit usage.
- **`@oxagen/code-graph` package** — new package for the tree-sitter-based code graph builder, shared by ingestion and the CLI.
- **`@oxagen/agent-engine` package** — new shared package (see Features above).
- **`apps/schemas`** — new app hosting `oxagen-cli-settings-schema.json` on Vercel with a schema drift test.
- **Database migrations** — `agent_sandbox_sessions` table, `workspace_memory_policy` table, and two-axis memory policy migration added.
- **ClickHouse migration runner** — `memory_changes_enforcement` migration added (`telemetry`).
- **Test coverage** — database package at 94% lines (gate raised to 85%); agent-engine, code-graph, handlers, auth, and CLI packages all gained comprehensive unit-test suites. Several flaky tests de-flaked (bulk-import `findBy` vs `getBy`, welcome-screen timers).
- **`skills-lock.json` removed** (`a509856e`, #344).
- **`pnpm eval:app` script** and `tools/scripts/eval-ingest.ts` added for one-command benchmark runs.
- **Turbo build inputs** — test files excluded from build inputs; parallelisation improved across the monorepo (`eb96f3af`, #304).
- **ADR-018, ADR-019, ADR-020** published under `docs/adr/`.

## What's new in Oxagen v0.6.4

This release is a large step forward for the platform, shipping a fully unified agent engine, a production-ready CLI, browser automation capabilities, durable sandbox sessions, a bidirectional CLI↔workspace graph sync, and a sweeping set of bug fixes that unblocked several runtime-dead capability surfaces. Alongside the new features, this release closes IAM privilege-escalation gaps, resolves a critical whole-API outage caused by a module-scope import, regenerates a stale contract barrel that silently killed 19 capabilities at runtime, and hardens CI with better parallelism, timeouts, and coverage gates.

---

### Features

**Unified Agent Engine (`@oxagen/agent-engine`)**

- Extracted a new shared `@oxagen/agent-engine` package (ADR-019) containing the pipeline, planner, model router, rate card, fleet orchestrator, evaluator, and judge — shared by both the CLI and the in-app agent (`edb8be29`, `e60f573c`, `1f85130d`).
- CLI agent loop now routes AI calls through the platform instead of calling provider SDKs directly; code-graph, memory, and execution-lineage sync are wired in as port adapters (`e60f573c`).

**CLI — Major expansion**

- `oxagen login`: browser-based loopback OAuth (PKCE + single-use code store) with a tenant/workspace picker and workspace linker (`.oxagen/workspace.json`) (`66f1ffeb`, `53dc8730`, `8008798e`).
- `oxagen init` / `/init` slash command: scaffolds `.oxagen` settings, builds a local code graph, and prints stats and domain summary (`f100e58f`).
- `/tui` fullscreen toggle and slash-command typeahead menu (`d8fbd458`).
- Agent turn timeouts and ETA indicator (`edb8be29`).
- `/verbose` structured session telemetry, baked-in rate card, and `oxagen cost` command (`9c9943f0`).
- Cross-vendor model routing: OpenAI advisor + evaluator-chosen worker (`708f9730`).
- Unified settings driver (`~/.oxagen/settings.json`) covering env, model, permissions, and hooks — home-dir global, Claude Code-style (`4281e9c7`, `290b92b2`).
- CLI execution-lineage up-sync to the workspace graph (ADR-018 slice 3) (`c8df7d5a`).
- Full CLI documentation published under `apps/docs/content/docs/cli/` covering installation, account setup, commands, configuration, knowledge graph, and a quickstart (`bfe2e51d`).

**Code Graph**

- New `@oxagen/code-graph` package: unified tree-sitter builder shared by ingestion and the CLI (`290e9a8c`).
- `CALLS` and cross-package `IMPORTS` edges for execution-flow graphs (`b260428b`).
- LLM-powered domain inference; every code-graph node gets a `domain` property (`2b1cf066`).
- Commit → `SourceFile` `:MODIFIED` edges for recent-changes queries (`9401769a`).
- `code.map` agent tool: structured code-map retrieval, graph-before-grep (`832359c2`).
- CLI persists the code graph to DuckDB and wires daemon graph handlers (`8677699f`).

**Graph Sync (ADR-018)**

- CLI ↔ workspace graph bidirectional sync: `graph.sync.push` (up-sync) and `graph.export` (down-sync to a local DuckDB replica) (`a78aea01`, `5d623155`).
- `graph.sync.push` and `graph.export` exposed as API routes, MCP tools, and documented capabilities.

**Durable Sandbox (`agent.sandbox.*`)**

- `agent.sandbox.start/stop/exec/snapshot` capabilities backed by a Modal runner with a pre-installed Playwright + `browserctl` image (`5fc8cbe9`, `ad4b9d91`, `0ce662d0`, `b9c1aea1`, `0be7ea6c`).
- `agent.sandbox_sessions` Postgres table with RLS policy registered in the manifest.

**Browser Automation (`browser.*`)**

- Seven new browser capabilities (`browser.navigate`, `.fill`, `.submit`, `.click`, `.refresh`, `.read`, `.screenshot`) driving a durable-sandbox browser session (`d6b0275b`, `59b20fe4`).
- Full API routes, MCP tools, and capability reference docs for all seven operations.

**Feature Verification (`agent.feature.verify`)**

- Cross-LLM judge surface: a separate-vendor vision model reads screenshots and requirement against a checklist, returning a `pass/fail/inconclusive` verdict (`ea47a23b`, `3ca39018`).
- `feature-browser-proof` skill codifies the end-to-end definition-of-done loop (sandbox → browser → judge) for any visible feature.

**Agentic Coding (`agent.repo.edit`)**

- `agent.repo.edit` handler runs the full `runTurn` pipeline and opens a pull request on a connected repo (`7709271b`, `fa5b0839`, `94560c9e`).
- GitHub write capabilities: `repo.create`, `repo.fork`, `repo.branch.create`, `repo.file.put`, `repo.pr.open` — all documented and contract-tested (`94560c9e`).
- Personal-account repos supported in `repo.create` (previously 404-ed) (`ce4904d2`).

**GitHub App Integration**

- Per-workspace GitHub token resolution (ADR-020): App installation tokens preferred, OAuth-connection fallback (`f62c5d69`).
- GitHub App connect flow in workspace settings; Sources tab skips install if already connected (`1365d172`).
- `/github/setup` landing route handles the App reconfigure redirect (`aabfd26c`).

**Memory**

- `agent.memory.list`, `.remember`, `.update`, `.delete` handlers wired end-to-end to Neo4j (`306f0c63`, `ad1a38ba`).
- In-app memory import (bulk) and manual creation UI (`a5359867`).

**IAM / Capabilities**

- `org.list` and `workspace.list` capabilities added across contracts, handlers, API routes, and MCP tools (`1758a183`, `53dc8730`, `bcf61d48`).

**Agentic Chat UI**

- Repo selector, environment selector, CI monitor, and PR inspection card added as foundational components for in-app coding-agent workflow (`b2fe700b`).
- In-app agent drawer persists conversations across turns with UI polish (`0a260319`).

**App — Environments & Secrets**

- Environments & Secrets vault UI with `.env` bulk-import (`0639b28f`).

**Benchmark Suite**

- Oxagen Code Agent Benchmark Suite: context-eval (`oxagen` vs Claude Code on repo-grounded Q&A), RAG eval (RAGAS/DeepEval bridge), and Terminal-Bench (Harbor) adapter for the CLI (`1e65ef7a`, `f591efca`, `092fd6e3`).
- One-command eval runner with ClickHouse ingestion for eval results (`e23be06e`).

**Telemetry**

- ClickHouse `eval_runs` + `eval_results` protocol and migration runner (`f7fafe85`).

---

### Fixes

**Critical / Runtime**

- `fix(api)` — Guarded module-scope `fileURLToPath` in skill handlers that was crashing the entire API on cold start (`FUNCTION_INVOCATION_FAILED`) (`34ff931a`).
- `fix(oxagen)` — Regenerated stale contract barrel; 19 capabilities (`agent.memory.delete` et al.) were dead at runtime (`ad1a38ba`).
- `fix(graph)` — Unblocked the knowledge-graph explorer: accept all explore ops and serialise concurrent Neo4j reads with scoped-session locking (`b08db8c4`, `aa8999a8`).

**IAM / Auth**

- Org owner is now treated as a super-user and is never locked out by an un-seeded capability (`ed6fc2c2`).
- API keys now authorize as their creator rather than failing closed on enterprise orgs (`a9fc062d`).
- Auth API-key resolution uses a fixed 12-char prefix window instead of `_` split (`73f28dfc`).
- IAM `fetch-authz` unblocks org/workspace listing (`edb8be29`).

**CLI**

- Fixed `/init` hang caused by `.gitignore` interaction and log spam; `Esc` now stops/resets; Enterprise prompt-override unlock (`9249978b`).
- Fixed `ReferenceError` in login picker-failure catch (`err` unbound) (`1226afad`).
- Corrected API endpoint paths in linker (double `user/` prefix removed) (`f2cfa54a`).
- Closed session-memory handle leak when REPL unmounts mid-open (`bfd9e6a0`).
- CLI graph push now labels symbols `:SourceSymbol` not `:Symbol` (`de4e1fd6`).
- Global settings tier stored at `~/.oxagen/` (home-dir) (`290b92b2`).
- Fixed `TS18048` optional-chaining TypeScript errors, dead frame ternary, flaky welcome-screen timer tests, and several test-assertion/merge-conflict regressions (`e0eb1fb6`, `83d4545b`, `d0747571`).

**Graph / Ontology**

- Enforced PascalCase node labels everywhere; inferred nodes now get descriptive labels instead of `:SEMANTIC_EDGE` / generic fallbacks (`93abe34a`, `dd95533e`, `66474030`).
- Idempotent Neo4j migration over duplicate `publicId` legacy `KnowledgeNode`s (`4afa3d36`).
- Graph explorer: fixed create-node/edge dialog vocabulary wiring (`aa8999a8`).

**App**

- Removed Integrations nav item and route accidentally resurrected by merge (`8a79f497`, `897bd7a1`).
- Repaired broken Memory settings page (`1d461c01`).
- Schema-builder Storybook stories 404 fixed: serve fixtures, not live API (`398d660d`).
- Agent bar no longer appears in workspace-less sections (`1ae961b4`).
- GitHub source wizard setup-URL leg now correctly advances after install (`ebc00ae9`).

**API / Handlers**

- `repo.create` `org` field is now optional (stale test removed); `org.list` unsafe-any lint fixed (`0b0152ec`).
- `GET /v1/auth/whoami` credential-probe endpoint added to unblock CLI API-key login (`eb8a5178`).
- `MCP` tools for `org.list` and `workspace.list` registered for contract parity (`bcf61d48`).
- `plugin.catalog.sync` REST route and contract test added (`728438c2`).
- Parallelized independent async I/O operations across handlers for lower latency (`d585887b`).

**Database / RLS**

- `workspace.workspace_memory_policy` added to the RLS `POLICY_MANIFEST` (`2c4e55be`).
- `agent.sandbox_sessions` registered in `POLICY_MANIFEST` (`6a3d3e1b`).

**GitHub**

- Fallback to OAuth token when GitHub App token minting fails (`dca716f7`).
- Dropped `.js` import extensions so Turbopack can resolve them (`4a6b6316`).

---

### Internal

- **`@oxagen/agent-engine`** extracted as a standalone package; CLI and in-app agent now share one brain (ADR-019) (`e60f573c`).
- **`@oxagen/code-graph`** extracted as a standalone package shared by ingestion and CLI (`290e9a8c`).
- **`@oxagen/github`** extracted as a standalone package with fetch-based client (replacing Octokit, which broke the Next.js build), App-auth, and per-workspace token resolution (`3fadbb85`, `f62c5d69`).
- **`@oxagen/sandbox`** package added with Modal driver and local shim for durable sandbox lifecycle (`b9c1aea1`).
- ADR-018 (CLI↔workspace graph sync), ADR-019 (unified agent engine), and ADR-020 (per-workspace GitHub credentials) published.
- Turbo pipeline optimised for parallelism and cache efficiency; `checks` job timeout raised to 60 min for cold-cache PRs (`eb96f3af`, `fe62db20`).
- Node heap raised to 8 GB for app build/typecheck to fix CI cold-build OOM (`62431335`).
- Database unit-test coverage raised to 94 % lines; gate raised to 85 % (`b971b257`).
- Latent lint and ingestion-test breakage cleared from the affected set (`4abcf90c`).
- Stale agent task context files (`task-abstract-create-function`, `task-storage-vendor-unlock`, `task-transactional-emails-saas`) removed from `.agents/tasks/`.

## What's new in v0.7.0

This is the largest release since the project launched, delivering a production-ready CLI with full account management and code-graph sync, a browser-automation capability surface, durable agent sandboxes, agentic GitHub write operations, a cross-LLM feature-verification judge, a new `@oxagen/agent-engine` shared package, a structured eval framework, and dozens of bug fixes across the API, app, and infrastructure layers.

---

### Features

#### CLI — `@oxagen/cli`

- **`oxagen init` / `/init`** — scaffolds `.oxagen/` settings, builds the local code graph, and prints domain statistics on first run (`f100e58f`).
- **`oxagen login` and account-required gate** — enforces authentication before any network-backed command; aligns with ADR-019 §4 (`df4aac2d`).
- **REPL + one-shot wired to `@oxagen/agent-engine` `runTurn`** — the CLI loop now delegates to the shared engine rather than its own fork (`2d836c96`).
- **Fullscreen TUI toggle + slash-command typeahead menu** — `/` in the REPL opens an autocomplete menu over available slash commands (`d8fbd458`).
- **Slash-command catalog** — full `oxagen/slash` module: catalog, expand, loader, writer, and types (`400e6efe`, `d8fbd458`).
- **Structured session telemetry, rate card, and `oxagen cost`** — `/verbose` mode emits token-level cost breakdowns; `oxagen cost` prints a per-session summary (`9c9943f0`).
- **Unified `settings.json` driver** — env, model, permissions, and hook configuration consolidated under `~/.oxagen/` (global) and `.oxagen/` (project), matching Claude Code parity (`4281e9c7`, `290b92b2`).
- **Cross-vendor model routing** — OpenAI advisor + evaluator-chosen worker; model router migrated into `@oxagen/agent-engine` (`708f9730`).
- **Engine port adapters** — workspace (gated `CwdWorkspace`), combined memory, code-graph/map, graph-sync, and AI adapters connecting the CLI to the engine's port interfaces (`f7ecb016`, `aae24e5e`).
- **Execution-lineage up-sync** (ADR-018 slice 3) — the CLI pushes `TOUCHED_FILE` edges to the platform graph after each turn (`c8df7d5a`).
- **CLI code-graph persisted to DuckDB + daemon graph handlers** (ADR-016 P0) — the local code graph survives daemon restarts (`8677699f`).
- **MCP client module** — `oxagen/mcp` with a typed client and full test coverage.
- **Rules engine** — `oxagen/rules` enforce, loader, writer, and types for project-level rule files.
- **End-user CLI documentation** — install, account setup, commands, configuration, knowledge-graph, and quickstart guide added to `apps/docs` (`bfe2e51d`).

#### Code Graph — `@oxagen/code-graph`

- **New shared package** — unified tree-sitter builder consumed by both the ingestion pipeline and the CLI, eliminating the duplicate parser (`290e9a8c`).
- **`CALLS` + cross-package `IMPORTS` edges** — execution-flow edges now captured during graph construction (`b260428b`).
- **LLM domain inference** — a domain property is inferred via LLM and attached to every code-graph node (`2b1cf066`).

#### Agent Engine — `@oxagen/agent-engine` (new package)

- **`runTurn` engine** — CLI brain modules (pipeline, evaluator, judge, planner, model router, rate card, system prompt) migrated into a new publishable package (`1f85130d`, `887802a7`).
- **Port interfaces (`ports.ts`)** — typed workspace, memory, code-graph, graph-sync, and AI ports for adapter injection.
- **Fleet orchestrator and types** — multi-agent fleet planner included in the package.

#### Browser Automation

- **`browser.*` capability surface** — `navigate`, `fill`, `submit`, `click`, `refresh`, `read`, and `screenshot` capabilities backed by a Playwright browser running inside a durable Modal sandbox (`d6b0275b`).
- **API + MCP routes** — all seven browser capabilities wired to REST routes and MCP tools with contract tests (`59b20fe4`).
- **`feature-browser-proof` skill** — an agent skill that drives the full browser-proof loop: provision sandbox → build → drive browser → screenshot → independent judge verdict (`d6b0275b`, `ea47a23b`).
- **`agent.feature.verify` cross-LLM judge** — takes requirement text + screenshot keys and calls a different-vendor vision model for an independent pass/fail verdict (`ea47a23b`, `3ca39018`).

#### Durable Sandboxes

- **`agent.sandbox.*` capabilities** — `start`, `exec`, `snapshot`, and `stop` backed by a Modal runner with a local shim for development (`5fc8cbe9`, `b9c1aea1`).
- **`agent.sandbox_sessions` database table** — Postgres table with RLS registered in the policy manifest (`0ce762d0`, `6a3d3e1b`).
- **Playwright + `browserctl` pre-installed** in the durable agent image (`0be7ea6c`).
- **API + MCP routes** for all sandbox capabilities (`ad4b9d91`).

#### GitHub Write Capabilities

- **`agent.repo.edit`** — the in-app agent can now edit a connected repo and open a pull request via the full `runTurn` pipeline (`7709271b`, `fa5b0839`).
- **`repo.*` capability handlers** — `repo.create`, `repo.file.put`, `repo.fork`, `repo.branch.create`, `repo.pr.open` registered in the handler registry.
- **`@oxagen/github` package** — per-workspace token resolution: GitHub App installation tokens preferred, OAuth-connection fallback (ADR-020) (`f62c5d69`).
- **`/github/setup` landing route** — handles GitHub App reconfigure/redirect flow in the app (`aabfd26c`).

#### Graph Sync

- **`graph.sync.push` + CLI code-delta up-sync** (ADR-018 slice 2) — the CLI can push a code-graph delta to the platform via the new handler and API route (`a78aea01`).
- **`graph.export` + bidirectional sync** (ADR-018) — down-sync writes a local DuckDB replica from the platform graph export (`5d623155`).
- **Commit → `SourceFile` `:MODIFIED` edges** — ingestion now links recent commits to source files for graph-based recent-changes queries (`9401769a`).

#### Code Map

- **`code.map` tool and handler** — structured code-map retrieval exposed as an agent tool, preferring graph traversal before grep (`832359c2`).
- **API + MCP route** for `code.map` (`25e01e75` partial, `832359c2`).

#### OpenAI-Compatible LLM Proxy

- **`agent.llm` API route** — an OpenAI-compatible proxy endpoint that CLI agents can target for model calls, with comprehensive request/response tests (`25e01e75`).

#### Eval Framework

- **`bench/context-eval`** — Python eval runner comparing Oxagen vs Claude Code on repo-grounded Q&A (`092fd6e3`).
- **`bench/terminal-bench`** — Terminal-Bench (Harbor) adapter for the Oxagen CLI (`84f54a01`, `f591efca`).
- **`bench/rag-eval`** — RAGAS/DeepEval bridge for context-quality evaluation (`bc09553f`).
- **ClickHouse eval-results ingestion** — `eval_runs` + `eval_results` tables and ingestion script (`f7fafe85`, `e23be06e`).
- **`tools/scripts/run-evals.ts` + `eval-ingest.ts`** — one-command eval runner and ClickHouse ingest script.

#### App

- **Environments & Secrets vault UI** — settings panel for workspace environment variables with bulk `.env` paste import (`0639b28f`).
- **In-app agent panel** — persistent drawer conversations and UI polish (`0a020319`).
- **`agent.memory.list`** — contract, Neo4j `listMemories` query, and Memories tab now reads from Neo4j (`306f0c63`, `c6f5ffc0`).
- **`plugin.catalog.sync` REST route** — syncs the plugin catalog on demand (`728438c2`).

#### Infrastructure / ADRs

- ADR-018 (CLI ↔ workspace graph bidirectional sync), ADR-019 (unified agent engine), and ADR-020 (per-workspace GitHub write credentials) documented.
- CI checks timeout raised from 20 min → 60 min for cold-cache PRs; Turbopack build heap raised to 8 GB (`fe62db20`, `62431335`).

---

### Fixes

- **`agent.llm` / `streamAgentReply`** — `stopWhen` and `onError` callbacks now forwarded correctly (`6bd2c8da`).
- **GitHub OAuth setup** — the Setup-URL leg no longer drops the connection after install (`ebc00ae9`); OAuth token is used as fallback when App token minting fails (`dca716f7`).
- **`agent-engine` Turbopack imports** — extensionless relative imports replace `.js` extensions, unblocking `@oxagen/app` cold build (`ff0b5299`).
- **`@oxagen/github` Turbopack imports** — `.js` import extensions dropped so Turbopack can resolve them (`4a6b6316`).
- **CLI REPL session-memory handle** — handle is now closed when the REPL unmounts mid-open, preventing a file-descriptor leak (`bfd9e6a0`).
- **CLI graph push node labels** — symbols are now labelled `:SourceSymbol` instead of `:Symbol` (`de4e1fd6`).
- **CLI global settings tier** — settings correctly resolve at `~/.oxagen/` (home-dir) matching Claude Code parity (`290b92b2`).
- **CLI standalone publish** — `workspace:*` dependency leak removed from the release bundle (`a2bd4b57`).
- **`engram` CJS barrel** — `run-golden` CLI self-exec guarded so the barrel doesn't crash the CJS API bundle (`0dea2ec1`).
- **API `fileURLToPath`** — module-scope call guarded in skill handlers, fixing a `FUNCTION_INVOCATION_FAILED` that took down the entire API (`34ff931a`).
- **`agent.sandbox_sessions` RLS** — table registered in `POLICY_MANIFEST` (`6a3d3e1b`).
- **`ontology` migration** — idempotent over duplicate `publicId` legacy `KnowledgeNode`s (`4afa3d36`).
- **In-app agent bar** — suppressed in workspace-less shell sections (`1ae961b4`).
- **Schema reconcile** — `pin→reconcile` surface bug, AI-hang guard, and `graph.export` registry gap resolved (`95b8e9fd`).
- **`dev` pre-flight** — port pre-flight added so `pnpm dev` no longer crashes when the stack is already running (`04d944b7`).
- **`bench` Python version** — Harbor runner pinned to Python 3.13 (`327d2086`).
- **CLI TypeScript errors** — TS18048 optional-chaining fixes, dead frame ternary removed, flaky welcome-screen timer tests stabilised (`e0eb1fb6`, `d0747571`, `83d4545b`, `efa91aba`, `ce230d7f`).
- **`agent` prefer-const lint gate** — dead `callCount` variable removed, unblocking the affected CI gate (`74b6c0b1`).

---

### Internal

- **`@oxagen/agent-engine` package bootstrapped** — new workspace package with its own `vitest.config.ts`, `tsconfig.json`, and publish manifest (`1f85130d`).
- **`@oxagen/code-graph` package bootstrapped** — new workspace package wrapping the shared tree-sitter builder (`290e9a8c`).
- **`@oxagen/github` package bootstrapped** — encapsulates App auth, fetch client, and workspace token resolution (`f62c5d69`).
- **`@oxagen/sandbox` package** — Modal runner + local shim for durable sandbox lifecycle (`5fc8cbe9`).
- **CLI brain tests migrated** — evaluator and judge tests removed from `apps/cli`; equivalent tests live in `@oxagen/agent-engine` (`a10eff2d`).
- **Coverage gates raised** — lines/statements gate raised to 85%; `@oxagen/database` unit tests reach 94% lines (`b971b257`, `7af7e57e`).
- **Turbo task graph updated** — test files excluded from build inputs; eval and graph-sync tasks added (`turbo.json`).
- **`.env.example` regenerated** — `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_PERSONAL_ACCESS_TOKEN` entries added; legacy CLI evaluator/advisor vars reorganised (`2c60fa7c`).
- **KFC spec-workflow agent suite** — `spec-requirements`, `spec-design`, `spec-tasks`, `spec-impl`, `spec-judge`, and `spec-test` sub-agents added under `.claude/agents/kfc/` for AI-assisted spec authoring.

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

