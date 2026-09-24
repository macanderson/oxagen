# Oxagen adversarial architecture review: steering, the graph, and the gateway

| | |
|---|---|
| **Status** | **Approved in full by the maintainer on 2026-09-18.** Nothing in it is a proposal or an open question. The unverified risk at the end of section 5 was closed the same day: both OpenAI and Anthropic work through a base URL proxy, subscription logins included, and neither vendor's terms explicitly forbid it, validated by the maintainer on 2026-09-18. It does not gate Phase 4 |
| **Date** | 2026-09-18 |
| **Reviewed at** | oxagen `main` `85377729a`. Read-only review, no code changed. Re-verified against `main` `02278c913` on the same day: see the addendum at the end. Phase 0 merged later that day as `c9db463e9` (PR #3289), so where the body and the addendum say `context.system` is hardcoded `null`, that was true at the commits they name and is not true on `main` now |
| **What it changed** | The design moved from "one store" to **one assembler**: `assembleSteering(run, budget)` with a stable prefix, a volatile selection and a `steering.manifest` frame. Storage stays plural with one writer per fact. Steering and gating became two planes, authored on one surface and compiled twice. `tachod` grows into the gateway (a loopback model proxy and an MCP aggregator). The enforcement tier became a four-word ladder: observe, harness, gateway, contained. The sandbox became the top tier, with `oxagen run -- <agent>`, and ADR-043 was revised by one sentence. Skills became governed files under Steering, and Steering became the hub with seven tabs. The work became a six-phase refactor path, with new governance ceremony frozen until Phase 0 lands |
| **Spec sections** | `oxagen-roadmap:docs/oxagen/specs/mission-control/spec.md`: §4.2 (stores, one writer per fact), §7.1 to §7.5 (the gateway, the tier ladder, the adapters, the five injection points), §9 (where a record lives), §10.4 (delivery, and what is true today), §10.5 (the assembler contract), §10.6 (skills), §10.7 (the Steering hub), §12.5 and §12.6 (budgets, and the basis of a spend number), §17.2 (the refactor path), §13.6 (bodies and the gateway), §18 (the closed risk), §21 (the decisions) |
| **Plan phases** | `oxagen-roadmap:docs/oxagen/specs/mission-control/plan.md` §8: Phase 0, make one record steer one agent. Phase 1, one type, one assembler. Phase 2, one screen. Phase 3, the graph becomes the index. Phase 4, the gateway. Phase 5, the contained tier. §0.2 lists the decisions and §8.8 reconciles the phases with the batches, lanes and milestones |
| **Other documents amended** | `docs/specs/oxagen-desktop/spec.md` §14, `docs/specs/tacho/spec.md` §7.5, `packages/tacho/README.md`, `packages/context-provider/README.md`, `docs/VISION.md` (`packages/engram` has no README, and none was created). The DoD, witness, walkthrough and scope-review documents live in the roadmap repository and were amended there |
| **ADRs** | ADR-091, Phase 0 (oxagen PR #3289). In oxagen draft PR #3294 (branch `steering-gateway-adrs`): ADR-097 "Steering and gating are two planes, authored on one surface and compiled twice". ADR-093 "One assembler decides what reaches the agent, and records what it cut". ADR-094 "tachod grows into the gateway: a loopback model proxy and an MCP aggregator". ADR-095 "The tier ladder is four words, computed from what was routed". ADR-096 "Oxagen may contain the process that runs turns: the contained tier". Amended there: ADR-008, 043, 051, 056, 064, 078 and 090 |
| **Build order and issues** | The phase names and numbers are the review's. The order of build is Phase 0 merged (PR #3289, `c9db463e9`, 2026-09-18), Phase 4 in build (branches `gateway-model-proxy` and `desktop-install-hardening`), then Phases 1, 2, 3 and 5. Issues, all in macanderson/oxagen: epic #3295. Phase 0 #2592 (reopened, P0). Phase 1 #3296. Phase 2 #3297. Phase 3 #3298. Phase 4 #3299 (P0, in build). Phase 5 #3300. Desktop review #3301. Defects #3302, #3303, #3304 and #3305 |
| **Copies** | The roadmap repository (https://github.com/macanderson/roadmap) carries this same record at `docs/reviews/2026-09-18-steering-graph-gateway-review.md`. The text below the rule is the review as it was written and is not edited |

## Corrections found on verification (2026-09-18)

The review below is kept as written. These five points were checked at oxagen `main` `02278c913` after it was written, and the specs, the plan and the ADRs follow this section where it differs from the body.

1. **An override cannot replace the governance prompt.** Section 2.1 says it can. `chat.system` is append-only, and only `conversation.title` is overridable (`OVERRIDABLE_PROMPT_KEYS`, `packages/ai/src/prompts/registry.ts`). What holds is narrower: `additionalInstructions` is appended unranked, unbudgeted and never checked against a rule (issue #3303).
2. **Five hook events run as command hooks, and four can refuse.** `COMMAND_HOOK_EVENTS` in `packages/tacho/src/host/settings-writer.ts` is `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest` and `Stop`. `Stop` is the fifth, and it refuses nothing.
3. **"Fail-open" describes the tier, not the hook process.** The hook process fails closed against its cached bundle: in enforce mode a stale or unverified bundle denies non-read-only tools. The tier is fail-open against the person at the keyboard, who can remove the hook entry, disable hooks or run another build of the harness. Section 2.2's heading means the second sense.
4. **`packages/engram` has no application importer, and two files still name it:** `tools/scripts/package.json` and `apps/app/next.config.ts`. "Dead" in the body means no app, handler or function calls it.
5. **The unverified risk at the end of section 5 is closed.** Both OpenAI and Anthropic work through a base URL proxy, subscription logins included, and neither vendor's terms explicitly forbid it: validated by the maintainer on 2026-09-18. It is a decided fact, recorded in ADR-094, and it does not gate Phase 4.

The addendum at the end of this file carries the line references that moved.

---

Date: 2026-09-18. Reviewed at `main` 85377729a. Read-only review, no code changed.
Every claim below was read in code unless marked "docs only".

## 1. Verdict in five lines

1. Your instinct is right about the read path and wrong about storage. What must be
   single is the **assembler**: the one function where everything competes for the
   agent's limited context. Storage can stay plural if each fact has exactly one writer.
2. The real problem is worse than "disconnected sources". On `main`, almost **nothing
   reaches an agent at all**. There is nothing to feel connected.
3. The wrapped tier is, in production, a recorder plus a kill switch. No rule can fire.
4. The design you want already exists in your own spec (`oxagen-roadmap:docs/oxagen/specs/mission-control/spec.md`
   §4.2, §7, §10.4). The code diverged from it. This is a spec-to-code gap, not a missing idea.
5. Yes, Oxagen should become an egress gateway, with a sandbox as its top tier. No, the
   sandbox should not be the only tier, and hooks should not be removed.

## 2. What is actually built (the facts)

### 2.1 Steering: eight type families, two injection paths, no shared budget

| Source                                             | Where it lives                                                                                                                                                        | Reaches an agent?                                                                                                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context records                                    | Postgres `agent.context_records` and versions, promotions ledger, proposals; mirrored as `.oxagen/rules/*.toml` in git                                                | **No.** No run-time reader exists. `rg contextRecords` finds only handlers, schema and the UI. ADR-051's injection path was deleted by ADR-043 and never re-landed (issue #2592). Only Stella reading the checkout sees them. |
| Policy bundle `context.system`                     | `packages/tacho/src/wire.ts:375`, consumed at `collector/hook-handler.ts:373`                                                                                         | **No.** Server hardcodes `null` at `packages/handlers/src/lib/tacho-host.ts:276`.                                                                                                                                             |
| Bundle permissions, tools, budget                  | same file, `:269-275`                                                                                                                                                 | **No.** Always empty arrays, `budget.mode = "observed"`. `session_limit_usd` is read by nothing.                                                                                                                              |
| Skills                                             | ADR-008 describes `packages/skills` and `agent.skills` tables. **Neither exists.** Only `tacho.sessions.skills_available`, an inventory of what the harness reported. | No. Observation only.                                                                                                                                                                                                         |
| Knowledge graph and ontology                       | Neo4j via `packages/ontology`, `packages/ingestion`                                                                                                                   | Only if the model chooses to call `graph.*` tools. Off unless `NEO4J_URI` is set. No nav entry in the app.                                                                                                                    |
| Memory                                             | Neo4j `:AgentMemory`, recalled at `packages/agent/src/runtime/assistant-recall.ts:82`                                                                                 | Yes, but only for the in-app agent. Capped at 6 items by a constant.                                                                                                                                                          |
| `packages/engram` plus `packages/context-provider` | A second memory system and the **only real token budgeter** (`context-provider/src/budget.ts:37`)                                                                     | **No production importer.** Dead. Deleted on 2026-09-22 (ADR-143). The budget moved to `packages/steering-assembler`.                                                                                                                                                                                             |
| Decision rules, mandates, auto-approval            | `workspaces.settings.decisionRules` JSONB, `tools.mandates`                                                                                                           | They refuse calls at `kernel.invoke()`. They never produce prompt text. Not in the path of a wrapped agent at all.                                                                                                            |
| `workspaces.promptConfig.additionalInstructions`   | Postgres JSONB                                                                                                                                                        | Yes, in-app agent only. Appended unconditionally. An override can replace the whole governance prompt with no check against rules.                                                                                            |
| Operator steer commands                            | `tacho.control_commands`, drained at `hook-handler.ts:217`                                                                                                            | Yes. **This is the only live server-to-running-agent text channel for wrapped agents.**                                                                                                                                       |

Consequences that matter:

- A workspace can write a record, pass six checks, get a second-person review under a
  governance mode, merge a pull request, append a hash-chained ledger row, and **no Claude
  Code or Codex run behaves differently**. The ceremony was built before the delivery.
- Two publish paths write the same row. `publish_context_record` leaves `kind` and `force`
  empty, so ordering by force is undefined for those rows (`schema/agent.ts:1295`).
- A recalled memory of class RULE is rendered as "never violate a RULE", while a published
  record with `force = must` is never in the same prompt. No precedence rule exists
  because the two never meet.
- The spec says records are `:Record` nodes in the graph. There are zero hits for that in
  `packages/ontology` or `packages/ingestion`. The graph holds no steering.

### 2.2 The wrap: file edits plus a daemon, client-attested, fail-open

- Wrapping is not a supervisor. `oxagen tacho enroll` writes hook entries into the
  harness's settings file and installs the `tachod` daemon. No command launches the agent.
- Only four hook events can block: `PreToolUse`, `UserPromptSubmit`, `SessionStart`,
  `PermissionRequest`. With an empty bundle, `PreToolUse` can deny only on host status or
  a paused session.
- **No model proxy exists.** Zero source hits for `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`
  or `/v1/messages`. ADR-056 says so plainly. The Mission Control spec describes the proxy
  as present; that is docs only.
- Token and cost numbers for Claude Code are the harness's own telemetry, self-reported.
  Codex and Stella export none, so their spend is silently absent.
- The MCP gateway (`packages/tacho/src/collector/mcp-gateway.ts`) is real and server-enforced,
  but it is registered only into Claude Desktop. A wrapped Claude Code still talks to every
  other MCP server directly.
- No sandbox remains after ADR-043. No filesystem, network or egress containment.
  The witness runner of ADR-064 is not built.
- Bypass: delete the hook entry, set `disableAllHooks`, kill the daemon, go offline, add
  another MCP server, or just run `claude` elsewhere. Detection is after the fact. Most
  failure paths return `{}`, which means allow.

ADR-078 and the Tacho README are honest about all of this. The spec and the marketing
surface are ahead of the code.

## 3. Where your instinct is right, and where I push back

**Right:** everything that can influence a run competes for one finite window, so there
must be one place where that competition is decided, ranked, budgeted and recorded. Today
there is none. Skills belong in that competition. One screen called Steering should own
all of it.

**Status on 2026-09-22.** This finding is closed. The assembler is `assembleSteering` in
`packages/steering-assembler/src/assemble.ts`, and `packages/handlers/src/lib/tacho-steering.ts`
is its only caller. The budget is `CONTEXT_SYSTEM_BUDGET_TOKENS` in that file. The manifest
names every candidate as included or cut, with the reason. It rides the policy bundle as
`context.manifest`, and the host seals it into the run as a `steering.manifest` frame
(`packages/tacho/src/collector/steering-manifest.ts`). ADR-143 records the decision.

**Push back 1: "single source" is three different things.**

- _System of record_: where a fact is authored. One writer per fact. Git for what is
  published. Postgres for what must be transactional or money-grade. The graph for
  lineage, evidence and entity links.
- _Index_: where facts are queried at run time.
- _Assembler_: where they compete for the window.

Only the assembler and its index must be single. Collapsing the systems of record into
Neo4j would be a mistake. Your spec §4.2 already gets this right: "the graph is the
system of record, git is the system of control", with one writer per fact.

**Push back 2: steering and gating are two planes and must not merge.**

- _Steering_ is what the model reads. It is advisory, ranked, budgeted, and may be dropped.
- _Gating_ is what the kernel refuses. It is deterministic, never budgeted, never ranked,
  and must work when Neo4j is down.

"Policy rules" in your list are gating. If a deny rule lived only in a graph and competed
for context, a relevance score could drop it. So: **one authoring surface, two
compilations.** Every item compiles to prompt text. Items with an enforcement grant also
compile to bundle permissions and kernel rules. Each gate also emits a one-line steering
notice so the agent does not waste turns walking into a denial.

**Push back 3: you do not own the context window.** For Claude Code and Codex users, the
harness owns it. Oxagen controls exactly these injection points:

1. `SessionStart` additional context, capped at 16 KiB today.
2. `UserPromptSubmit` additional context. This one receives the user's prompt, so it can
   retrieve by relevance per prompt. It is unused for steering today.
3. MCP tool results.
4. Files in the checkout, including skills, which the harness loads by its own rules.
5. The model request itself, only once a proxy exists.

So "competition for the window" means competition for Oxagen's slice of it. That makes
the assembler small and buildable now, at hook tier, without waiting for a proxy.

**Push back 4: the graph should be the index, but it must not block delivery.** The graph
earns its place through `ABOUT` edges: "records relevant to the files and entities this
run touches". That is a real advantage over a flat list. But the knowledge graph is off
by default and a workspace has tens of records, not millions. Put the index behind a
port, ship the first version on the Postgres registry, and move the read to the graph
once records are projected into it. If delivery waits for the graph, nothing ships again.

**Push back 5: skills are steering, but they are files.** A skill is a harness-native
artifact loaded by the harness's own progressive disclosure. Oxagen cannot put it in the
prompt. It can govern it like a record, through a pull request, and deliver it by
materializing files. Its description line competes in the assembler like any other item.

## 4. The target shape

```
            AUTHORING (one surface: Steering)
   records | skills | memory | ontology | policy | proposals
                       |
            one item type: SteeringItem
   id, lineage, kind, force, scope, body, token_cost,
   enforcement grant?, provenance, hash, valid_from
                       |
        +--------------+---------------+
        |                              |
  compile to TEXT                compile to GATES
  assembleSteering(run, budget)  bundle permissions + kernel rules
  ranked, budgeted, recorded     deterministic, never budgeted
        |                              |
        +-------------+----------------+
                      |
                 THE GATEWAY (tachod grows into it)
   hook adapter | local model proxy | MCP aggregator | control channel
                      |
   tiers, computed from what was actually routed:
   observe -> harness -> gateway -> contained (sandbox)
```

The assembler returns three things: a stable prefix (`must` and `should` items, cached in
the signed bundle, works offline), a volatile selection (`may` and `info` items picked per
prompt under a token budget), and a **manifest** of what was rendered and what was cut.
The manifest is recorded as a frame. Without it you can never measure whether a record
had any effect, and the retirement and promotion features stay unbuildable.

## 5. Should Oxagen be a sandbox gateway?

**Yes to gateway. Sandbox as the top tier, not the only tier.**

Why a gateway: hooks alone can never earn the word "enforced". The hook runs inside a
process the user owns. A control plane whose every control is advisory is a dashboard.
The three seams in spec §7.1 are the right design. Only one of the three is built.

Why not sandbox-only:

- On a laptop the developer owns, nothing is enforceable against the owner. A mandatory
  sandbox there buys friction, not security. Toolchains, SSH keys, Docker and local
  services all break.
- You have zero customers and the stated mix is Claude Code and Codex on laptops. A
  sandbox-first product kills adoption at the first install.
- Enforcement only means something where the operator is not the machine owner: managed
  devices, CI, cloud runners, headless fleets. That is also where unattended risk lives and
  what a security buyer pays for. Aim the sandbox there.

The design move that makes this cheap: **run the model proxy on loopback inside `tachod`.**
The daemon already exists, already listens on loopback, already receives telemetry.

- No extra network hop and no new availability dependency on Oxagen's cloud.
- No prompt body is sent to Oxagen's servers. The proxy forwards bodies to the vendor,
  as the harness does today; only digests and usage go up. You avoid taking custody of
  every customer's source code in transit.
- The vendor credential stays on the machine.
- Metering becomes observed instead of self-reported, for every harness, including Codex
  and Stella.
- Per-turn steering injection, hard budgets and real interrupt all become possible.

Inside the sandbox tier, the only allowed egress is the gateway. That single rule turns
all three seams from attested to enforced, because the agent cannot reach a model or a
tool server any other way.

ADR-043 needs one sentence of revision: Oxagen does not run turns, but it may contain the
process that does. A launcher that confines a process is not an agent runtime.

**Unverified risk to check before committing to the proxy:** whether Claude Code and Codex
subscription logins, as opposed to API keys, pass cleanly through a base URL rewrite, and
whether the vendors' terms allow it. I did not test this. It decides how much of the
laptop population the proxy can cover.

## 6. Refactor path

Each phase ships alone and is useful alone.

**Phase 0. Make one record steer one agent.** Days, not weeks.

- Compile active records with `force` of `must` or `should` into `context.system` in
  `unsignedBundle`. The etag already covers content, and the steering version is already
  the ledger length, so a merge bumps the bundle for free.
- Reopen #2592 against this seam, as ADR-051's supersession note asks.
- Freeze new governance ceremony until this lands.

**Phase 1. One type, one assembler.**

- Define `SteeringItem` and `assembleSteering(run, budget)` returning prefix, volatile
  selection and manifest.
  The prefix and the manifest are done on 2026-09-22. The volatile selection is not built yet.
- Give it source adapters: record registry, `:AgentMemory`, gate notices from rules and
  mandates, skill descriptions, and `promptConfig.additionalInstructions`.
- Reuse `packWithinBudget` from `packages/context-provider`. Repoint that package at the
  adapters and make it the assembler's home. Delete `packages/engram` or fold what is
  worth keeping. Two memory systems become one.
  Done on 2026-09-22 with a change of home: the assembler lives in
  `packages/steering-assembler`, and both memory packages are deleted (ADR-143).
- Wire `UserPromptSubmit` to call the assembler with the prompt as the query, tight
  timeout, fail open.
- Fix precedence in one place: gate beats everything, published `must` beats recalled
  memory, repository scope may narrow workspace scope and never widen it.
- Collapse the two publish paths so every row carries `kind` and `force`.
- Point the in-app agent's `assistant-turn.ts` at the same assembler, so there is one.

**Phase 2. One screen.**

- Steering becomes the hub. Tabs: Records, Skills, Memory, Ontology, Policy, Proposals.
- Add a **Preview** tab: pick an agent and a prompt, see exactly what would be injected,
  what was cut, and why. This is the page that makes the competition visible.
- Move Skills under it. Give Ontology a home there. Skills become governed files
  delivered by sync, authored through the same pull request flow.

**Phase 3. The graph becomes the index.**

- Project every item as a `:Record` node with `ABOUT` edges to files, repos and entities,
  as spec §9 describes. One direction only, registry to graph, verified by hash.
- Switch the assembler's relevance stage to the graph. Keep the Postgres path as fallback
  behind the same port.
- Do this when the knowledge graph is on by default, not before.

**Phase 4. The gateway.**

- Add the loopback model proxy to `tachod`: Anthropic Messages and OpenAI Responses
  passthrough with streaming. Enrollment writes the base URL.
- Move metering to observed. Enforce `session_limit_usd`. Re-land ADR-051's per-turn
  volatile injection at the proxy. Implement real `interrupt`.
- Turn the MCP gateway into an aggregator for wrapped harnesses. Enrollment re-serves the
  harness's existing MCP servers through loopback, using the displace-and-restore logic
  `mcp-config-writer.ts` already has. Where a vendor offers managed settings, pin it.
- Fill bundle permissions from the second compilation of Phase 1.

**Phase 5. The contained tier.**

- `oxagen run -- <agent>`: a supervisor that launches the agent under an OS sandbox with
  egress limited to the gateway. Target CI and headless runs first.
- Add `contained` as the honest top word in the tier ladder. Build the witness runner of
  ADR-064 on the same launcher.

## 7. Documentation drift found along the way

- `oxagen-roadmap:docs/oxagen/specs/mission-control/spec.md` §7 describes the model proxy, base URL enrollment,
  run tokens and proxy budgets as present. None exist.
- ADR-008 describes a skills package, tables and loader that do not exist.
- ADR-056 says no producer appends to the run ledger. `assistant-run.ts` and `run.fork.ts` now do.
- `apps/app_deprecated` is still in the tree and holds the only other `resolvePrompt` wiring.

---

## Addendum: re-verified against `main` at `02278c913` (2026-09-18)

`main` moved after the review was written (the Run page landed in #3282). Every fact in section 2 was read again in code. All but one still hold. Three line references moved, one claim does not hold, and two details are worth adding:

| Review says | At `02278c913` |
|---|---|
| Bundle `context.system` consumed at `collector/hook-handler.ts:373` | The `SessionStart` case reads it at `hook-handler.ts:322` and answers with it at `:375` |
| Operator steer commands drained at `hook-handler.ts:217` | `drainMessages` is defined at `hook-handler.ts:216` |
| `schema/agent.ts:1295` for the two publish paths | The comment that says a record published through `publish_context_record` has NULL `kind` and `force` is at `packages/database/src/schema/agent.ts:1300-1302`, above `contextRecords` at `:1303` |
| "Most failure paths return `{}`" | Confirmed in `packages/tacho/src/claude-code/hook-client.ts:215-295`. With the daemon down every hook answers `{}`, except `PreToolUse`, which decides from the cached bundle |
| "An override can replace the whole governance prompt with no check against rules" (section 2.1, the `additionalInstructions` row) | Not true at `02278c913`. `packages/ai/src/prompts/registry.ts` makes `chat.system` append-only: a full override is allowed only for `conversation.title`. What is true is the first half: `additionalInstructions` is appended to every prompt, unconditionally, with no check against rules (`registry.ts:82`). The specs say only that |
| Tier vocabulary | `TACHO_ENFORCEMENT_TIERS` is `gateway`, `harness`, `observe` (`packages/database/src/schema/tacho.ts:74`). `gateway` is earned today only by a Claude Desktop host connected through the MCP gateway (`TACHO_HARNESS_TIERS`, `packages/tacho/src/wire.ts:175`, ADR-078), which routes tools and no model traffic |

Unchanged and confirmed: `unsignedBundle` hardcodes `context: { system: null }` at `packages/handlers/src/lib/tacho-host.ts:276` with empty permissions and `budget.mode = "observed"` at `:269-275`. No source file mentions `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` or `/v1/messages`. Nothing reads `session_limit_usd` outside the wire schema and the Stella engine client's types. `RECALL_LIMIT = 6` at `packages/agent/src/runtime/assistant-recall.ts:23`. `packWithinBudget` at `packages/context-provider/src/budget.ts:37`. No production code imports `@oxagen/engram` or `@oxagen/context-provider` (`apps/app/next.config.ts` and `tools/scripts/package.json` still name engram, and nothing calls it). No `:Record` label in `packages/ontology` or `packages/ingestion`. No skills package or skills tables, only `tacho.sessions.skills_available`. `apps/app_deprecated` is still in the tree.
