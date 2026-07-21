# Agent Tool Roadmap

> **Superseded for launch (2026-07-21).** This is a historical 2026-07-11
> inventory, so its counts, tool surfaces, and recommendations predate the launch
> pruning. Do not use it to reintroduce generic graph mutation/sync, a central
> source-symbol graph, or automatic execution-to-file lineage. The exact code graph
> stays local; Oxagen retains governed provider metadata and durable run traces.
> Canonical protected/default-ref topology and a typed evidence ledger are follow-ups.
> The audit body is preserved below as historical evidence.

_Last audited: 2026-07-11, via direct source inspection (packages/agent-engine, packages/agent, apps/app, apps/api, apps/mcp, apps/cli, crates/) — not from docs alone. Counts drift as capabilities ship; re-verify before quoting numbers in a Linear ticket or external doc._

## TL;DR — three separate tool-delivery mechanisms, not one

It's tempting to think of "the agent's tools" as a single list. In this codebase it's actually **three structurally independent mechanisms** that happen to converge at one merge point inside the engine:

1. **`buildWorkspaceTools`** (`packages/agent-engine/src/tools.ts:476`) — the **hands**. ~14 filesystem/exec/diagnostic primitives (`read_file`, `bash`, `grep`, …). Shared identically between the CLI (always on) and the in-app/API agent (only in "code mode," and backed by a remote Modal sandbox instead of the CLI's real local filesystem).
2. **`materializeTools`** (`packages/agent/src/runtime/materialize-tools.ts:303`) — the **reach**. Auto-converts any of **264 capability contracts** tagged for the `agent` surface into an LLM tool (billing, connectors, evals, schema, memory, subagent fan-out, web, repo, …). Used only by the in-app chat route, the API's `chat.stream`, and the A2A bridge — all three call the same `runCodingAgent`. **The CLI never calls this function. Zero hits on grep.**
3. **The MCP tool registry** (`apps/mcp/src/tools/*.ts`) — **320 tools**, exposed in the *opposite direction*: to any external MCP client (Claude Desktop, Claude Code, a partner's own agent) that connects to `mcp.oxagen.sh/mcp`. This is not "tools Oxagen's agent consumes" — it's "capabilities Oxagen gives away." It happens to be the closest thing to a full capability catalog, since every MCP-registered tool maps 1:1 to a real contract.

(1) and (2) merge into one tool object at `packages/agent-engine/src/engine.ts:118` (`tools = { ...tools, ...opts.extraTools }`) before the shared ADR-030 speculative-execution wrapper and the caller's own permission gate apply. The **merge point** is shared engineering; the **inventory feeding it** is not.

```
              buildWorkspaceTools ("hands")                    materializeTools ("reach")
   read_file / write_file / edit_file / list_dir /        264 agent-surfaced capability contracts:
   glob / grep / bash / code_graph / ask_user +            billing, connectors, evals, schema, memory,
   5 structured diagnostics (test/build/git/health)        subagent-dispatch, web, repo, ontology, …
        │                                                          │
   CLI: always              App/API/A2A: code-mode only    App chat.stream / API chat.stream / A2A bridge
        └──────────────────────┬───────────────────────────────────┘
                    engine.ts:118 merge seam (shared)
                                │
                     ADR-030 speculation + permission gate

   MCP tool registry (apps/mcp) — 320 tools — SEPARATE, REVERSE DIRECTION
   Exposed TO external MCP clients. Not consumed by Oxagen's own agent loop at all.
```

## Table A — Engine "hands" tools (`packages/agent-engine/src/tools.ts`)

| Tool | Purpose | In-App Agent | API (`chat.stream` / A2A) | MCP (external clients) | CLI (`apps/cli`) | Rust CLI (`stella`) |
|---|---|---|---|---|---|---|
| `read_file` | line-numbered file read | ✅ code-mode only | ✅ code-mode only | — (`read_sandbox_file` is the durable-session analogue) | ✅ always | ✅ shipped (Phase 0/1) |
| `write_file` | create/overwrite file | ✅ code-mode, RW only | ✅ code-mode, RW only | — | ✅ RW only | ✅ shipped |
| `edit_file` | exact-substring replace, hash-anchored (unpoisonable-edits) | ✅ code-mode, RW only | ✅ code-mode, RW only | — | ✅ RW only | ✅ shipped |
| `list_dir` | non-recursive listing | ✅ code-mode | ✅ code-mode | — | ✅ | — not confirmed as a distinct tool |
| `glob` | glob file search | ✅ code-mode | ✅ code-mode | — | ✅ | ✅ shipped |
| `grep` | regex content search | ✅ code-mode | ✅ code-mode | — | ✅ | ✅ shipped |
| `bash` | shell exec, timeout-bound | ✅ code-mode, remote Modal sandbox | ✅ code-mode, remote sandbox | — (`run_sandbox_command` is the durable-session analogue) | ✅ real local subprocess | ✅ shipped |
| `code_graph` | symbol/import/dependents/semantic search | ✅ conditional, Neo4j-backed | ✅ conditional, Neo4j-backed | — (`get_code_map` is a related but distinct capability tool) | ✅ always, local DuckDB-backed | ❌ planned Phase 3 (`oxagen-graph` crate exists, uncommitted, not wired) |
| `ask_user` | sync human clarification, 2–5 options | ❌ never wired (no `askUser` callback passed) | ❌ never wired | — | ✅ interactive REPL only, never headless/one-shot | ❌ not yet |
| `test_unit_run`, `test_trace_run`, `build_package_run`, `git_diff_summarize`, `workspace_health_check` | deterministic structured diagnostics (ADR-021 §3) — never mutate, always advertised even read-only | ✅ code-mode | ✅ code-mode | — | ✅ | ❌ not yet (natural Phase 2 territory) |

> **Launch correction to the historical table:** the central Neo4j-backed code-graph
> and `get_code_map` paths represented above are retired. The supported exact code
> graph is local to the checkout/worktree.

**Naming note:** these tool names deliberately break the `domain_subject_action` convention (ADR-025) — they're grandfathered "training-prior protected" names (agent models already know what `read_file`/`bash` mean), and were never renamed under the ADR-025 sweep.

## Table B — Capability "reach" tools, by domain

Every domain below is drawn from the 320 MCP-registered tools (`apps/mcp/src/tools/`), which is the closest thing to a full capability catalog since each MCP tool maps 1:1 to a contract. "Agent (materializeTools)" reflects whether that domain's contracts are tagged for the LLM-facing `agent` surface and therefore reachable by the in-app/API/A2A tool loop. *(Domain subtotals below sum to ~307 against a verified total of 320 — the research pass's own grouping had minor recount slack; treat the per-domain figures as approximate roll-ups, not exact accounting.)*

| Domain | MCP tools (#) | In-App / API / A2A agent (`materializeTools`) | CLI (native) | Rust CLI | Notes |
|---|---|---|---|---|---|
| Agent memory | 15 | ✅ subset (`save_memory`, `recall_memory`, `write_memory`, `cite_memory`) | ❌ | ❌ | Distinct from the engine's own automatic pre/post-turn recall hook, which the model never calls directly |
| Agent durable sandbox sessions | 9 | ⛔ **structurally excluded** — `WORKBENCH_ONLY_SANDBOX_CAPS` (`materialize-tools.ts:202-212`) | ❌ | ❌ | Reserved for the human Workbench UI. Reachable via MCP by external clients — see Finding 3 below |
| Subagent dispatch / fan-out | 8 | ✅ (`dispatch_subagent` + poll/aggregate/cancel), budget-capped 100 tasks/depth 3/250 descendants | ❌ (CLI's own `fleet.ts` is a separate human-only local orchestrator, not this tool) | ❌ | Two unrelated "spawn agents" concepts — don't conflate CLI fleet with `dispatch_subagent` |
| Agent-installed MCP servers | 6 | ✅ likely (registration/consent) | — (CLI has its own `mcp.ts` settings-based config, unrelated mechanism) | ❌ | |
| Agent definitions | 8 | ✅ likely | ✅ human command `agent.ts` (not LLM-tool) | ❌ | |
| Agent triggers | 4 | ✅ likely | ❌ | ❌ | |
| Agent execution & lineage | 3 | ✅ likely (read/audit) | ✅ human command `trace.ts`/`replay.ts` (not LLM-tool) | ❌ | |
| Agent file locks | 3 | ✅ likely | ✅ human command `file-lock.ts`; engine also has its own internal `withFileLock` wrapper for `write_file`/`edit_file` | ❌ | |
| Agent background tasks | 3 | ✅ likely | ❌ | ❌ | |
| Agent plan/approval | 3 | ✅ (HITL gate — `agent.requiresApproval:true` blocks on `waitForApproval`, emits `approval-required` SSE) | ❌ | ❌ | |
| Agent skill runtime | 2 | **Neither** — no "invoke a skill" tool exists at all | **Neither** | ❌ | Skills reach a turn by being pinned and injected straight into the system prompt (`pinnedSkillSlugs`/`pinnedSkillBodies`), not tool-called |
| Agent-environment binding | 3 | ✅ likely | ✅ human command `agent-env.ts`/`env.ts` (not LLM-tool) | ❌ | |
| Agent misc (`execute_code`, `edit_repo_file`, `verify_feature`, …) | 8 | ✅ but `execute_code`/`edit_repo_file` are **excluded specifically in code mode** (workspace tools already own file mutation that turn) | ❌ | ❌ | |
| Knowledge graph (Neo4j) | 13 | ✅ likely | ❌ | ❌ | |
| Ontology query layer (`query_ontology`, `get_ontology_neighbors`) | 2 | ✅ confirmed agent-surfaced | ⚠️ **contract declares `cli` as a surface, but no wired CLI command found** — Finding 4 | ❌ | The one primitive whose metadata claims CLI reach; unconfirmed in practice |
| Semantic relationships | 4 | ✅ likely | ❌ | ❌ | |
| Schema management | 21 | ✅ likely (mostly admin/config-shaped) | ❌ | ❌ | |
| Billing & reselling | 19 | ✅ likely (read-heavy subset plausible; full reseller admin less likely agent-exposed — not individually verified) | ❌ | ❌ | |
| Connectors & integrations | 35 | ✅ likely | ❌ | ❌ | |
| Workflows & automations | 9 | ✅ (`run_workflow` is a fan-out orchestrator, not a turn-by-turn tool pick) | ❌ | ❌ | See API surface note below |
| Evals | 8 | ✅ likely | ❌ | ❌ | |
| Security & compliance (secrets, API keys, privacy, audit) | 14 | ✅ likely, read-leaning | ❌ | ❌ | |
| Repo / code (GitHub-backed + code utilities) | 17 | ✅ confirmed (`open_pr`, `put_repo_file`, `repo.*` family) | — (CLI has its own local git via `bash`, plus human commands `pr.ts`/`gh.ts`) | ❌ | |
| Sandbox templates | 9 | ✅ likely (distinct from live sessions, which are excluded) | ✅ human command `sandbox-template.ts` (not LLM-tool) | ❌ | |
| Skills (authoring) | 14 | ✅ likely — build-time authoring, not turn-time invocation | ❌ | ❌ | See skill-runtime row above |
| Access / IAM / org / workspace / user / environments | 30 | ✅ likely, config-shaped | ❌ | ❌ | |
| Misc: conversations, documents, browser automation, images/video/diagrams, model router, chat, notifications, research swarm, web, singletons | 37 | ✅ confirmed for `search_web`/`fetch_web_page`; rest likely | ❌ | ❌ | `start_research_swarm` is a composite tool built on `dispatch_subagent` |

**CLI's actual capability-tool workaround:** since `materializeTools` is never called, the *only* way a CLI agent reaches any Table B tool is if the user manually adds Oxagen's own MCP server (`mcp.oxagen.sh/mcp`) as one of their configured external MCP servers in `apps/cli/src/commands/mcp.ts` — at which point `loadMcpTools` picks it up like any third-party MCP server. This isn't wired by default and isn't a substitute for native access (extra network hop, no code-mode-aware exclusions, no risk/entitlement filtering tuned for a local dev agent).

## Table C — Surface-exclusive extras (no equivalent elsewhere)

| Tool / mechanism | Surface | What it does |
|---|---|---|
| External user-configured MCP servers (`loadMcpTools`) | CLI only | The CLI's entire `extraTools` set is literally whatever third-party MCP servers the user has configured — no Oxagen-specific capability access by default |
| Per-agent tool allowlist (`filterToolsForAgent`) | CLI only | Glob-matches a named CLI agent's declared tool list (`Read`, `Bash`, `mcp__github__*`) — CLI's own analogue of `materializeTools`' allowlist, separately implemented |
| Rule-guard denies + `SessionStart`/`PreToolUse` hooks + permission broker | CLI only | App has a capability-driven approval/consent flow instead |
| `fleet.ts` command tree (dispatch/watch/attach/replay/bisect/…) | CLI only, human-invoked | Deterministic local orchestrator over worktree-isolated subagents + an append-only session log. **Not an LLM tool on either surface** |
| Commit ledger + `recover.ts` | CLI only | Append-only local git-object safety net; no app equivalent |
| Scope-review gate (Ctrl-O) | CLI only | Interactive "confirm scope & cost" overlay between ROUTE and EXECUTE |
| `ln`/`ModalSandboxWorkspace` remote exec | App/API/A2A only | Every "local" op (`read_file`, `bash`, …) actually runs through `agentSandboxExecHandler` inside a tenant-scoped, metered, durable Modal sandbox — the app agent never touches a real filesystem |
| 6 shipped tools (`read`/`write`/`edit`/`bash`/`grep`/`glob`) | Rust CLI only | Phase 0/1 of an 8-phase plan; no structured diagnostics, no code graph, no capability tools, no MCP client yet |

## Findings worth a decision, not just a note

1. **Rust CLI is branded "stella," not "oxagen."** Binary name, `--help` text, env var prefix (`STELLA_MODEL`), and both uncommitted crates' on-disk paths (`.stella/fleet.db`, `.stella/graph.db`) all say "stella" — the spec docs (`docs/specs/oxagen-rust-cli/`, all 10 files, dated after the "stella" commits) never use that name once, and describe `~/.config/oxagen/` layout throughout. This reads as either an unrecorded rebrand or scope/identity drift. **Needs a decision on the canonical name before more work lands on either.**
2. **The two uncommitted crates violate the Rust CLI's own binding architecture decision.** `02-architecture.md` §1.6 states: *"One storage engine. Everything persistent lives in embedded SQLite (rusqlite, bundled) … No DuckDB, no second embedded database, ever, without an ADR."* Both `crates/oxagen-fleet/` (commit ledger, file locks, agent registry) and `crates/oxagen-graph/` (graph store, code indexer) use `duckdb = { features = ["bundled", "chrono"] }` as their persistence layer — confirmed a real, exercised dependency (mid-compile during the research pass), not vestigial. No ADR supersedes the SQLite-only decision. **Either write the ADR or move these two crates to `rusqlite` before merging.**
3. **Sandbox-session tools are excluded from Oxagen's own agent but reachable via MCP.** `WORKBENCH_ONLY_SANDBOX_CAPS` structurally blocks `start_sandbox`/`run_sandbox_command`/`stop_sandbox`/etc. from ever becoming an in-app/API/A2A tool — but the same 9 capabilities are registered as ordinary MCP tools, reachable by any external client that connects with a valid API key. If MCP's own auth layer doesn't independently re-gate these (not confirmed either way this pass), an external MCP client would have durable-sandbox powers Oxagen's own chat agent structurally cannot exercise. **Worth an explicit yes/no on whether that's intentional.**
4. **`query_ontology`/`get_ontology_neighbors` declare `cli` as a surface, but no CLI command invokes them.** Either the contract's `surfaces` metadata is aspirational and should drop `cli`, or this is a real capability-parity gap — the CLI (and the Rust CLI's planned `oxagen-context`/OCP layer) would benefit from native graph grounding rather than relying solely on the local DuckDB code graph, given the graph-grounding wedge in `docs/VISION.md`.
5. **CLAUDE.md's umbrella-file list has a stale entry.** It documents a `semantic-relationship.ts` API route file covering `semantic.relationship.*` — that file doesn't exist. Only `semantic-edge.ts` exists, covering `semantic.edge.approve/infer/list/suggest`. Worth a small doc fix.

## Design philosophy: task-specific tools > bash — where we already do this well, and where we don't yet

The mission in `docs/VISION.md` (capability-parity typed contracts as the accountability chain nobody else bundles) and this codebase's actual tool design are unusually well aligned already:

- **320 typed MCP tools instead of one generic "invoke any capability" escape hatch.** An external agent gets `create_reseller_customer` with a real Zod schema, not `run_capability({name: "...", args: {...}})`. This is the wedge in practice — every tool is inherently governed (risk tier, entitlement check, audit record) because it's a distinct typed contract, not a string the model can construct freely.
- **The 5 structured diagnostic tools exist specifically to keep the agent out of raw shell parsing.** `git_diff_summarize`, `test_unit_run`, `test_trace_run`, `build_package_run`, `workspace_health_check` return structured, parseable results instead of the model running `bash git diff` / `bash npm test` and eyeballing terminal output. `test_trace_run` in particular ("debug grounded in the executed path, not grep guesses," per project history) is exactly the pattern: replace bash-and-grep archaeology with a purpose-built tool that returns the actual executed call path.
- **`edit_file`'s hash-anchor + syntax gate (unpoisonable-edits)** is a task-specific tool doing something a generic `bash sed` never could: refusing a write whose target region drifted since the model last read it, and refusing edits that break syntax — governance baked into the tool itself, not bolted on after.

Where the philosophy isn't fully realized yet:

- **The CLI's own 41 polished human commands (`pr.ts`, `graph.push/pull/search`, `cost.ts`, `secret.ts`, `sandbox.ts`, …) are not exposed as LLM tools at all.** A CLI agent asked "what's the CI status on this PR" almost certainly falls back to `bash gh pr checks` and parses terminal text, when `pr.ts` already has the structured logic to answer that directly.
- **CLI agents have zero native access to the 264 capability tools** app/API/A2A agents get — billing, connectors, evals, schema, org/workspace management. A CLI-based agent literally cannot query usage or manage a connector as a typed call; the only path is `bash curl` against the REST API (worse than a typed tool in every dimension: no schema, no risk gating, no audit trail attribution) or the undocumented external-MCP-server workaround in Table B.
- **`fleet.ts` (worktree-isolated multi-agent dispatch) is human-only.** There's no LLM-callable equivalent of `dispatch_subagent` that uses the CLI's local worktree + commit-ledger safety net — an agent that wants to fan out locally has no typed tool for it today.
- **Rust CLI ships only the 6 rawest primitives so far** (Phase 0/1) — no structured diagnostics, no code graph, no capability tools. Every "what changed" / "did the build pass" question a `stella` agent gets today can only be answered via raw `bash`.

## Recommendations

Ranked by leverage against the mission (metering→billing, contract governance, graph grounding, vendor neutrality, fleet lineage) and the task-specific-over-bash principle:

1. **Wrap `pr.ts`/`gh.ts` and `graph.*` as native CLI-agent tools** (`pr_status`, `pr_merge`, `ci_status`, `graph_search`, `graph_lineage`) instead of leaving them as human-only commands the agent has to shell out around. Cheapest win here — the structured logic already exists, it just isn't `tool()`-wrapped.
2. **Give CLI agents a native, filtered slice of the 264 capability tools** — start with read-only, low-risk ones (`get_usage_breakdown`, `query_audit_log`, `query_ontology`/`get_ontology_neighbors` to actually back the surface the contract already claims) rather than the full `materializeTools` surface. This directly serves the graph-grounding wedge for local dev agents, not just app users.
3. **Add a local, worktree-scoped `dispatch_subagent` equivalent for the CLI**, reusing the existing `fleet/orchestrator.ts` machinery but exposed as an actual LLM tool rather than a human-only command tree — gives CLI agents the same fan-out capability app agents already have, grounded in the CLI's superior local safety net (commit ledger, worktree isolation).
4. **Port the 5 structured diagnostic tools to the Rust CLI early (Phase 2), not late.** They're deterministic, cheap, and the TS engine is explicitly documented as "the spec, not the code" to port from — there's no design risk left to defer.
5. **Resolve Findings 1–2 (stella naming, DuckDB-vs-SQLite) before any more code lands on the uncommitted `oxagen-fleet`/`oxagen-graph` crates** — both are blocking questions, not roadmap nice-to-haves, since they determine whether that code merges as-is or gets rewritten.
6. **Confirm Finding 3 (sandbox-session MCP/native asymmetry) is intentional.** If not, either add the same `WORKBENCH_ONLY_SANDBOX_CAPS`-style exclusion to the MCP registration path, or gate it behind a stricter MCP scope than default API-key access.
7. **Never grow a raw "run any capability by name" tool** as a shortcut to CLI/Rust-CLI parity — the entire value of 320 typed contracts is that the model can't construct an arbitrary call; parity should be achieved by wiring more real typed tools (recommendation 2), not a generic dispatcher.

## Methodology

Compiled from five parallel read-only research passes (2026-07-11) over `packages/agent-engine`, `packages/agent`, `apps/app`, `apps/api`, `apps/mcp`, `apps/cli`, `crates/`, and `docs/specs/oxagen-rust-cli/`. Every count and file:line reference above was grounded in direct source reads, not inferred from documentation. Re-run this audit after any change to `buildWorkspaceTools`, `materializeTools`, the MCP tool registry, or a Rust CLI phase landing — the numbers here will drift.
