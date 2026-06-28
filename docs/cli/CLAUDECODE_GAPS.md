# Oxagen CLI vs. Claude Code — Capability Gap Analysis

**Status:** living doc · **Last reviewed:** 2026-06-26 · **Scope:** `apps/cli` (`@oxagen/cli`, the `oxagen` binary) measured against Anthropic's Claude Code CLI.

This document is an honest, code-grounded comparison between `oxagen` and Claude Code. It is **not** a claim that `oxagen` should become a Claude Code clone — `oxagen` already does several things Claude Code does not (see [§2](#2-where-oxagen-is-already-ahead)). The goal is to make the deltas explicit so we can decide, deliberately, which gaps to close, which to ignore, and which to leapfrog.

Every claim about `oxagen` is anchored to a source file. Claude Code behavior is described from its public feature set as of early 2026.

---

## 1. TL;DR

`oxagen` is a **genuinely capable single-loop coding agent** with a unique pre/post-processing pipeline and a parallel fleet mode. It is **missing most of the "platform" layer** that makes Claude Code safe to run unattended and extensible by third parties.

| Area | Claude Code | Oxagen CLI | Gap |
|---|---|---|---|
| Core file/shell tools | Read/Write/Edit/Glob/Grep/Bash | read/write/edit/list/glob/grep/bash + `code_graph` | **Minor** (oxagen adds code_graph) |
| Permission system | Modes + allow/ask/deny + sandbox | None — tools run unprompted; `--readonly` is the only gate | **Critical** |
| Hooks (lifecycle automation) | PreToolUse/PostToolUse/Stop/etc. | None | **Major** |
| MCP client (external tools) | First-class | None | **Major** |
| Checkpoints / rewind / undo | Esc-Esc rewind, file checkpoints | None — edits are irreversible | **Major** |
| Context compaction | Auto-compact + `/compact` + microcompact | None — history grows unbounded | **Major** |
| Session persistence / resume | `--continue`, `--resume`, forking | None — in-memory only | **Major** |
| Web access | WebFetch + WebSearch | None | **Major** |
| Diff display | Inline diffs on every edit | None — prints `Edited <path>` | **Major** |
| Interactive input editing | Cursor, history, autocomplete, `@`/`!`/`#` | Char-append only; no cursor or history | **Major** |
| Multimodal Read | Images, PDFs, notebooks | UTF-8 text only | **Moderate** |
| Background processes | Run/poll/kill long jobs | Single blocking `exec` with timeout | **Moderate** |
| Custom slash commands / skills | `.claude/commands`, skills, plugins | 7 built-in commands, no user commands | **Moderate** |
| Subagent customization | Named agent types, scoped tools | Fleet shares one tool set, separate screen | **Moderate** |
| Headless / SDK | `--print`, JSON streaming, Agent SDK | One-shot + stdin only | **Moderate** |
| **Model cost routing** | Manual / fixed | **Auto fast/balanced/precise tiering** | **Oxagen ahead** |
| **Completeness judging** | None | **Evaluate→Judge→Revise pipeline** | **Oxagen ahead** |
| **Structural code context** | Grep-based | **Precomputed code graph + auto-enhance** | **Oxagen ahead** |
| **Cross-session memory** | `CLAUDE.md` only | **Episodic + weighted lessons (engram)** | **Oxagen ahead** |
| **Turn introspection** | None | **`/replay` full pipeline trace** | **Oxagen ahead** |
| **Parallel fleet w/ DAG** | Ad-hoc `Task` tool | **Planner + dep graph + file-lock scheduler** | **Oxagen ahead** |

**The single most important gap is the permission/safety model.** `oxagen` executes `write_file`, `edit_file`, and `bash` with no approval prompt and no allowlist (`apps/cli/src/agent/tools.ts:10-13` documents this as a known v1 limitation). That is acceptable for a developer dogfooding their own repo, but it blocks every unattended, CI, or shared-environment use case — and it is the foundation Claude Code's hooks, modes, and sandbox all build on.

---

## 2. Where Oxagen is already ahead

Stated up front so the gap list below reads as *prioritization*, not *deficiency*. These are real, shipped, tested capabilities Claude Code does not have:

1. **Cost-aware model routing** (`agent/model-router.ts`). A deterministic classifier maps each prompt to a `fast` / `balanced` / `precise` tier (Haiku/Sonnet/Opus) from structural signals — high-stakes domains (auth, billing, security, migrations) always escalate; trivial work pins to Haiku. Claude Code uses one fixed model per session.
2. **Eval → Enhance → Route → Execute → Judge → Revise pipeline** (`agent/pipeline.ts`). Every prompt is scored for completeness/complexity, enriched with retrieved context, then — crucially — the finished work is **judged by a *different* model** for completeness and automatically sent back for revision if gaps remain. Claude Code has no built-in self-verification stage.
3. **Code graph as first-class context** (`agent/code-graph.ts`, `daemon/code-graph/*`). A precomputed symbol + import index answers "where is X defined" and "what imports this file" structurally, and the enhancer auto-injects the relevant slice before the agent acts (`agent/prompt-enhancer.ts`). Claude Code reaches for grep.
4. **Persistent, weighted cross-session memory** (`agent/memory.ts` via `@oxagen/engram`, `agent/fleet/memory.ts`). Episodic turn activity and weighted "lessons/gotchas" survive across sessions on the same repo and are recalled into future prompts. Claude Code's only persistence is the static `CLAUDE.md`.
5. **Full turn introspection — `/replay`** (`commands/replay.ts`, `repl/components.tsx` `TraceView`). Shows the prompt evaluation, injected context, model selection rationale, and judge verdicts for any past turn. Claude Code is a black box by comparison.
6. **Fleet orchestration with a real scheduler** (`agent/fleet/orchestrator.ts`, `agent/planner.ts`). A goal is decomposed into a dependency-ordered plan and executed by N parallel subagents with **file-ownership locking** so two agents never edit the same file at once. Claude Code's `Task` tool is fan-out without a dependency graph or write-conflict guard.
7. **Context daemon** (`daemon/*`) for warm indexes across invocations.
8. **Workspace env + secret vault commands** (`commands/env.ts`, `commands/secret.ts`) — encrypted secrets, per-environment overrides, access logging. Out of scope for Claude Code entirely.

Keep these. The recommendations below are about reaching Claude Code's *floor* on safety/UX/extensibility without sacrificing this ceiling.

---

## 3. Gap detail

### 3.1 Permission & safety model — **Critical**

**Claude Code:** permission modes (`default`, `acceptEdits`, `plan`, `bypassPermissions`); `allow`/`ask`/`deny` rules per tool and per argument pattern in `settings.json`; an OS-level sandbox; directory restrictions; and an interactive prompt before any mutating tool when the rule set doesn't pre-authorize it.

**Oxagen:** `agent/tools.ts:97-329` builds a fixed `ToolSet`. The only safety control is `opts.readOnly`, which *deletes* `write_file`/`edit_file`/`bash` from the set (`tools.ts:321-328`). There is no prompt, no allowlist, no per-command gating, no path confinement. The file header explicitly flags this:

> "Safety note (v1): tools execute without an interactive permission prompt … Per-tool approval gating is a planned enhancement." — `agent/tools.ts:10-13`

**Why it matters:** this is the keystone. Without a permission layer there is no safe unattended mode, no "yolo on a branch but ask on main," no command denylist (`rm -rf`, `curl | sh`, secret exfiltration), and no foundation for hooks. `bash` runs arbitrary commands with the user's full shell (`tools.ts:300-318`).

**Recommendation (highest priority):**
- Add a permission broker between the loop and tool `execute`. Minimum viable: an `ask`/`allow`/`deny` rule set + interactive approve/deny prompt in the REPL for `write_file`/`edit_file`/`bash`, with a remembered "always allow this command/path" option.
- Add a command denylist + path-confinement (reject writes outside cwd unless approved).
- Promote `--readonly` to a full mode enum (`ask` / `accept-edits` / `plan` / `readonly`) to match Claude Code's mental model.

### 3.2 Hooks — **Major**

**Claude Code:** shell hooks fire on lifecycle events (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, etc.). They can block a tool call, inject context, run a formatter/linter after every edit, or enforce policy — without touching the agent's prompt.

**Oxagen:** none. There is no extension point between the loop and the outside world. Formatting/linting after an edit, blocking a forbidden command, or notifying on completion all require code changes.

**Recommendation:** once the permission broker exists, generalize it into a hook dispatch (`PreToolUse`/`PostToolUse`/`Stop`) reading a config file. This is the single highest-leverage extensibility primitive and reuses the broker's interception point.

### 3.3 MCP client — **Major**

**Claude Code:** connects to any number of MCP servers (stdio/SSE/HTTP) and exposes their tools to the model, with on-demand schema loading.

**Oxagen:** the tool set is hard-coded (`tools.ts`). The agent cannot reach Linear, GitHub, Postgres, a browser, or any of the MCP servers this very monorepo ships (`apps/mcp`). Ironic given Oxagen *is* an MCP platform — the CLI can't consume its own MCP surface.

**Recommendation:** add an MCP client that merges discovered tools into `buildTools()`. Start with stdio transport and a `.oxagen/mcp.json` server list. This immediately unlocks the platform's own capabilities (`mcp.oxagen.sh`) inside the local agent.

### 3.4 Checkpoints / rewind / undo — **Major**

**Claude Code:** automatic checkpointing; Esc-Esc (or `/rewind`) restores the conversation *and* the file tree to a prior turn. Edits are reversible.

**Oxagen:** `edit_file`/`write_file` mutate the disk directly and irreversibly (`tools.ts:132-173`). The trace store records *what* changed (`filesTouched`) but keeps no content snapshot, so there is no undo. `/clear` resets the conversation but not the filesystem.

**Recommendation:** snapshot touched files (or lean on a shadow git stash/commit per turn) so a `/rewind <n>` can restore both conversation history and working tree. The trace store already enumerates `filesTouched` per turn — extend it with content hashes/blobs.

### 3.5 Context window management / compaction — **Major**

**Claude Code:** monitors context usage, auto-compacts (summarizes) when the window fills, supports manual `/compact`, and microcompacts tool results. Long sessions stay healthy.

**Oxagen:** `repl/interactive.tsx:296` does `historyRef.current = result.messages` — the **full** message history (including every tool result) is fed back verbatim every turn and never trimmed or summarized. Tool outputs are individually clipped to 30 KB (`tools.ts:25`), but nothing bounds the *conversation*. A long REPL session will grow input tokens monotonically until the model's context overflows and turns start failing.

**Recommendation:** add a context budgeter — track cumulative history tokens (the data is already in `result.usage`), and at a threshold either summarize older turns or drop/elide stale tool results. Surface a `/compact` command and a context-usage indicator in the status bar (the bar already shows session tokens — `components.tsx:202-250`).

### 3.6 Session persistence & resume — **Major**

**Claude Code:** `--continue` resumes the latest session; `--resume` picks one; sessions can be forked; transcripts persist to disk.

**Oxagen:** conversation history is in-memory (`historyRef`), discarded on exit. Traces and memory persist (`openTraceStore`, `openSessionMemory`), but you cannot resume a conversation. One-shot mode (`repl/one-shot.ts`) is fully stateless.

**Recommendation:** persist the message history alongside traces, keyed by a session id, and add `oxagen --continue` / `--resume`. The trace store is the natural home.

### 3.7 Web access — **Major**

**Claude Code:** `WebFetch` (fetch + extract a URL) and `WebSearch` give the agent live documentation, changelogs, and error-message lookup.

**Oxagen:** no network tools. The agent cannot read a linked doc, check a library's current API, or search for an error. For a platform whose own dependencies churn (Next 16, AI SDK 6), this is a real handicap.

**Recommendation:** add `web_fetch` and `web_search` tools (gated by the new permission layer — network egress should be approvable/denyable).

### 3.8 Diff display — **Major (UX)**

**Claude Code:** every edit renders a syntax-highlighted, line-numbered diff so the user sees exactly what changed before/after approval.

**Oxagen:** `edit_file` returns the string `"Edited <path>"` (`tools.ts:168`); the REPL renders a tool call as `toolName → <input truncated to 100 chars>` (`interactive.tsx:43-48`, `components.tsx:142-151`). The user **never sees the actual change** unless they re-read the file. With no permission prompt *and* no diff, edits are completely opaque at the moment they happen.

**Recommendation:** compute and render a unified diff in `edit_file`/`write_file` results (and in the approval prompt once §3.1 lands). High impact, low effort.

### 3.9 Interactive input editing — **Major (UX)**

**Claude Code:** full line editing (cursor movement, word jumps), input history (up/down), slash-command and file (`@`) autocomplete, `!` bash passthrough, `#` to append a memory, image paste, optional vim mode.

**Oxagen:** `PromptInput` (`repl/components.tsx:48-91`) handles only Return, Backspace/Delete, and character append. **There is no cursor** — you cannot move left/right or edit mid-string; a typo means backspacing to it. No input history (no up-arrow recall). No autocomplete. No `@`/`!`/`#` affordances. This is the most-felt day-to-day gap.

**Recommendation:** replace the hand-rolled input with a real line editor (e.g. `ink-text-input` or a cursor-aware component), add up/down history from past prompts, and add slash + `@file` autocomplete. Add `@path` expansion in the prompt (resolve to file contents) and `!cmd` passthrough.

### 3.10 Multimodal Read — **Moderate**

**Claude Code:** `Read` renders images (PNG/JPG), PDFs (by page range), and Jupyter notebooks (cells + outputs).

**Oxagen:** `read_file` is `fs.readFile(..., "utf8")` (`tools.ts:118-129`) — text only. Binary/image/PDF reads return mojibake. No notebook awareness; no `NotebookEdit`.

**Recommendation:** detect image/PDF and pass as multimodal content parts (AI SDK supports image/file parts); lower priority unless notebook/design workflows matter.

### 3.11 Background processes — **Moderate**

**Claude Code:** runs long commands in the background and exposes `BashOutput`/`KillShell` to poll and stop them (dev servers, watchers, test runners).

**Oxagen:** `bash` is a single `execAsync` with a max 600 s timeout and a 10 MB buffer (`tools.ts:289-318`). No backgrounding, no streaming output, no kill, no persistent shell state between calls (each call is a fresh `/bin/bash`). Starting `pnpm dev` blocks the whole turn until timeout.

**Recommendation:** add a background-job variant (`run_in_background` + `bash_output` + `kill_shell`). Relevant for this repo specifically, where `pnpm dev` is long-running.

### 3.12 Custom slash commands, skills, plugins — **Moderate**

**Claude Code:** user/project slash commands (`.claude/commands/*.md`), Skills, and a plugin/marketplace system extend the agent declaratively.

**Oxagen:** 7 hard-coded slash commands (`/help`, `/model`, `/replay`, `/traces`, `/pipeline`, `/clear`, `/exit` — `repl/interactive.tsx:148-215`, `components.tsx:26-36`). No mechanism to add a project command or skill. (Note: project *rules* via `CLAUDE.md`/`AGENTS.md` *are* supported — see §3.13.)

**Recommendation:** load `.oxagen/commands/*.md` as prompt-template slash commands. Skills/plugins can wait until hooks + MCP exist.

### 3.13 Project memory / instructions — **Mostly at parity, minor gaps**

**At parity (good):** `agent/project-context.ts` walks up from cwd collecting `CLAUDE.md`, `AGENTS.md`, `.oxagen/rules.md`, `.cursorrules`, `.github/copilot-instructions.md` (8 levels, 16 KB cap), nearest-wins ordering, injected once into the stable system prompt for cache warmth. This is solid and arguably broader than Claude Code (multi-format).

**Gaps:**
- **No global/user memory.** Claude Code reads `~/.claude/CLAUDE.md` (user-level rules across all projects). `loadProjectContext` only walks *up from cwd* to the FS root — it never consults a home-dir global rules file.
- **No `@path` imports.** Claude Code's `CLAUDE.md` can `@import` other files. Oxagen reads each rule file literally.
- **No `/memory` command** to view/edit loaded rules, and no `#`-shortcut to append a memory mid-session.

**Recommendation:** add a user-global rules file (`~/.config/oxagen/CLAUDE.md`) to the walk, support `@relative/path` imports, and add `/memory`.

### 3.14 Subagent customization & in-loop delegation — **Moderate**

**Claude Code:** `Task` tool spawns subagents *from within the conversation*; named agent types (`general-purpose`, `Explore`, custom) each get a tailored system prompt and a scoped tool set; results flow back into the parent loop.

**Oxagen:** the fleet (`agent/fleet/orchestrator.ts`) is powerful but **lives on a separate `oxagen agents` screen**, not inside the chat loop. Within a REPL conversation you cannot say "dispatch three agents to do X" and get their results back into the turn. Every subagent runs the same `runAgent` with the same full tool set (`orchestrator.ts:238-253`) — no per-agent tool scoping, no read-only researcher vs. writer roles, no custom agent personas. Subagents don't nest.

**Recommendation:** expose a `dispatch_subagents` tool inside the loop so the chat agent can delegate mid-conversation (the orchestrator already supports `dispatchPrompt`). Add agent "roles" with scoped tool sets (e.g. a read-only Explore role) — cheap given `buildTools` already accepts `{ readOnly }`.

### 3.15 Plan mode — **Moderate**

**Claude Code:** a first-class plan mode researches read-only, presents a plan, and requires explicit approval (`ExitPlanMode`) before any mutation.

**Oxagen:** `--readonly` gives the read-only half, and the `agents` planner produces a plan, but there is no integrated "plan → approve → execute" handshake in the REPL. The planner and the executor are separate entry points.

**Recommendation:** add a `/plan` REPL mode that runs read-only, emits a plan, and on approval flips to execution against that plan — reusing `planTasks` + the fleet.

### 3.16 Headless / SDK / scripting — **Moderate**

**Claude Code:** `--print` non-interactive mode, `--output-format json|stream-json`, session ids for resumption, and a programmatic Agent SDK.

**Oxagen:** one-shot (`oxagen "prompt"`) and piped stdin (`repl/one-shot.ts`) exist, which covers basic scripting. Missing: structured (`--json`) output, stream-json, resumable session ids, and any importable SDK surface. CI/automation consumers get only free-text on stdout.

**Recommendation:** add `--json` to one-shot mode emitting the `TurnTrace` (already a clean structured object) plus the final text. This is nearly free given the trace already exists.

### 3.17 Smaller deltas

- **`edit_file` has no `replace_all`.** It hard-fails when `old_string` appears more than once (`tools.ts:163-166`). Claude Code's `Edit` supports `replace_all` for rename-style edits. Add the flag.
- **No telemetry/OTEL export.** Claude Code can emit OpenTelemetry. Oxagen tracks usage/cost internally (`model-router.ts`) but has no export hook.
- **No `/cost` breakdown / `/doctor` / `/init`.** Cost shows in the status bar but there's no detailed breakdown command; no environment doctor; no `/init` to scaffold a rules file.
- **No image paste / screenshot ingestion** in the REPL.
- **No IDE extensions** (VS Code/JetBrains) and no in-editor diff surface — Oxagen is terminal-only by design, which is fine, but worth noting as a reach surface.

---

## 4. Prioritized roadmap

Ordered by leverage (safety floor → daily UX → extensibility → reach). Each tier is roughly independent.

**P0 — Safety floor (unblocks everything unattended)**
1. **Permission broker** (§3.1): `ask`/`allow`/`deny` + interactive approval + command denylist + path confinement; mode enum.
2. **Diff display** (§3.8): render unified diffs on edits and in approval prompts. *(Pairs naturally with #1.)*
3. **Checkpoints / `/rewind`** (§3.4): per-turn file snapshots for undo.

**P1 — Daily-driver UX**
4. **Real input editor** (§3.9): cursor, history, autocomplete, `@`/`!`/`#`.
5. **Context compaction + usage indicator** (§3.5): bound the conversation; `/compact`.
6. **Session resume** (§3.6): `--continue` / `--resume`.

**P2 — Extensibility (where the platform compounds)**
7. **Hooks** (§3.2): generalize the broker's interception point.
8. **MCP client** (§3.3): consume Oxagen's own MCP surface + third-party servers.
9. **In-loop subagent delegation + roles** (§3.14).
10. **Custom slash commands** (§3.12); **user-global rules + `@imports`** (§3.13).

**P3 — Reach & polish**
11. **Web tools** (§3.7), **background processes** (§3.11), **multimodal Read** (§3.10).
12. **Headless `--json`** (§3.16), `replace_all` (§3.17), `/plan` mode (§3.15), `/cost`/`/doctor`/`/init`.

---

## 5. Strategic read

Closing the P0/P1 gaps brings `oxagen` to Claude Code's safety and ergonomics floor while keeping its three real advantages — **the completeness-judging pipeline, cost-aware routing, and graph-grounded context/memory**. Those are the differentiators worth marketing; the gaps above are mostly *table stakes* the market already expects.

The MCP gap (§3.3) is the one with outsized strategic upside: wiring the CLI to `mcp.oxagen.sh` makes the local agent a first-class client of the very platform it's built on, turning every Oxagen capability into a local coding-agent tool. That is a leapfrog, not a catch-up.

---

### Appendix — source map

| Capability | File |
|---|---|
| CLI entry / command surface | `apps/cli/src/index.tsx` |
| Local coding tools | `apps/cli/src/agent/tools.ts` |
| Agent loop | `apps/cli/src/agent/loop.ts` |
| System prompt | `apps/cli/src/agent/system-prompt.ts` |
| Turn pipeline (eval→judge→revise) | `apps/cli/src/agent/pipeline.ts` |
| Cost-aware model routing | `apps/cli/src/agent/model-router.ts` |
| Prompt enhancement (code graph) | `apps/cli/src/agent/prompt-enhancer.ts` |
| Evaluator / Judge | `apps/cli/src/agent/evaluator.ts`, `judge.ts` |
| Planner | `apps/cli/src/agent/planner.ts` |
| Fleet orchestrator | `apps/cli/src/agent/fleet/orchestrator.ts` |
| Episodic / fleet memory | `apps/cli/src/agent/memory.ts`, `fleet/memory.ts` |
| Project rules loading | `apps/cli/src/agent/project-context.ts` |
| Interactive REPL | `apps/cli/src/repl/interactive.tsx` |
| REPL components / slash help | `apps/cli/src/repl/components.tsx` |
| Trace store / replay | `apps/cli/src/agent/trace-store.ts`, `commands/replay.ts` |
| Context daemon / code graph | `apps/cli/src/daemon/*` |
