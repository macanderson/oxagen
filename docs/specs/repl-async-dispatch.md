# REPL async dispatch — always-parallel fleet dispatch from the composer

**Status:** design (implementation-ready)
**Owner:** CLI / REPL
**Goal:** "Dispatch fleets of agents working in parallel as much as possible. Keep entering prompts while the triager dispatches and figures out what to do with my requests. Very little lag between submitting a prompt and the system being ready for the next prompt."

This spec maps what exists today (with file:line evidence), names the smallest change that turns the existing `&` primitive into a first-class **Dispatch mode**, and pins down the concurrency, conflict, permission, and attribution behavior the mode needs to be safe.

---

## 1. Current-state map

### 1.1 The prompt queue — serial, single-consumer, FIFO

The REPL already lets you type and submit while a turn streams; submissions do **not** run in parallel — they queue and drain one at a time.

- Queue state: `apps/cli/src/repl/interactive.tsx:387-393` — `queued` (visible list) + `queueRef` (synchronous source of truth). Entry type `QueuedPrompt` at `interactive.tsx:251-254`.
- Single sequential consumer: `pump()` at `interactive.tsx:3238-3271` — `while (queueRef … .length > 0) { … await handleSubmitRef.current(next) }`. It **awaits each turn before starting the next**. Re-entrancy guarded by `pumpingRef`; a generation counter (`pumpGenRef`) lets `cancelTurn` steal the drain.
- Enqueue path: `handleUserSubmit` (`interactive.tsx:3291-3328`) → `enqueue` (`interactive.tsx:3276-3283`) → `void pump()`.
- `isStreaming` is set `true` for the **whole** turn: set at `interactive.tsx:2415-2416`, cleared at `interactive.tsx:3217-3218` (turn end) and `interactive.tsx:1091-1092` (cancel). The composer (`PromptInput`) stays live throughout — `busy={isStreaming}` (`interactive.tsx:3576`, `3796`) is a **visual** hint only; input and submit keep working. But because `pump` is awaiting the in-flight `handleSubmit`, a queued prompt cannot start until the current turn finishes.

**Pinned behavior** (`apps/cli/src/repl/__tests__/interactive.queue.test.tsx`): mid-turn submissions are visibly queued and not started early; they run FIFO as each prior turn completes; an idle submit runs immediately; the Esc-twice reset confirmation is answered **synchronously** and never enters the FIFO. Note: the two FIFO tests were `it.skip` from #271 until 2026-07-20 — the "flake" was a missing `project/init.js` mock (the first turn parked on the project-init approval prompt), not timing; all three tests now run.

> Net: today's queue is a **serial pipeline**. The composer accepts input during a turn, but throughput is one turn at a time. This is the exact bottleneck the user is describing.

### 1.2 The `&` suffix — the async primitive that already exists

A prompt ending in ` &` is dispatched to a **detached worker process** and the composer frees immediately.

- Handled in `handleSubmit`: `interactive.tsx:1715-1743`. `parseAmpersandDispatch(text)` (`apps/cli/src/sessions/dispatch.ts:55-60`) strips a trailing ` &` (ignores slash/shell commands and bare `&`); non-null → `dispatchDetachedSession({ cwd, prompt })` (`sessions/dispatch.ts:67-100`), then `return` (never runs the inline turn).
- `dispatchDetachedSession` creates the session dir and **re-execs this CLI** as `fleet worker <sid>`, `detached: true`, `stdio: "ignore"`, then `child.unref()` (`sessions/dispatch.ts:92-98`). Returns "typically well under 50 ms" (`sessions/dispatch.ts:64-65`). The worker's lifetime belongs to the store, **not** the terminal — so it **outlives the REPL**.

**The gap:** the REPL only *dispatches*; it never *observes* the session it spawned. The only references to `sessions/dispatch` in `interactive.tsx` are the two dynamic imports at `1719-1720` and `1725-1726`. There is **no** `store.watchSessions` / `store.tailEvents` subscription anywhere in `interactive.tsx`. So a `&` dispatch runs headless — to see it you open a **second terminal** and run `oxagen fleet` / `oxagen fleet watch` (`apps/cli/src/commands/fleet.ts:11-19`). Completions never fold back into the REPL transcript.

### 1.3 Two different "parallel" models already in the tree

**(a) Inline fleet turn** — a multi-task plan fans out to parallel subagents *within one turn*:
- `interactive.tsx:2686-2748`: when `plan.tasks.length > 1 && !bareRef.current`, the turn calls `runFleetTurn` (`apps/cli/src/repl/fleet-turn.ts:106-151`) → `Fleet` (`apps/cli/src/agent/fleet/orchestrator.ts`).
- Concurrency default 4 (`orchestrator.ts:143`); each subagent runs in its **own git worktree**, checkpointed and merged back (`fleet-turn.ts:107-111` default isolation inside a git repo; `orchestrator.ts:343-470` spawn/checkpoint/integrate/dispose).
- Safety: `pump()`/`pickReady()` (`orchestrator.ts:282-341`) enforce **dependencies** and **file-ownership** — two tasks with overlapping predicted `files` are serialized (`orchestrator.ts:336`), but **only within this one `Fleet` instance**. With worktree isolation on, overlap is allowed and collisions surface as **merge conflicts at integration** (`orchestrator.ts:333-338`, `412-430`); the shared-tree fallback uses `createLocalFileLockProvider` (`orchestrator.ts:155-160`).
- Results **fold into the transcript** and drive the Task Progress + Agent Team panels via `onTask` (`interactive.tsx:2713-2748`).
- **But it blocks the composer**: `await runFleetTurn(…)` sits inside `handleSubmit`, which `pump` awaits, and `isStreaming` stays true for the whole fleet run.

**(b) Detached worker** — one `&` dispatch = one worker process running a single conversation session:
- `apps/cli/src/sessions/runner.ts` runs **one `runTurn`** loop (single engine loop, not a `Fleet`) on the **shared `cwd`** (`runner.ts:336`, `484-501`), `readOnly: false`. It tails an inbox to thread follow-ups (`fleet send`). It does **not** itself fan out to a `Fleet`; parallelism across dispatches is process-level.
- Cross-process file safety: `createLocalFileLockProvider({ root: cwd })` (`runner.ts:336`). Its lock-file layer under `<cwd>/.oxagen/locks/` (`apps/cli/src/agent/fleet/local-file-lock.ts:143-156`) is what stops two **separate** worker processes writing the **same file** at once. It is coarse — per-file mutual exclusion, no worktree isolation.

### 1.4 Registries & daemon

- `agentRegistry` (`apps/cli/src/agent/agent-registry.ts:218`) — in-process singleton behind `/hud`; kinds `turn | subagent | fleet` (`agent-registry.ts:18`). **In-process only** — it does not see detached workers.
- `taskRegistry` (`apps/cli/src/agent/task-registry.ts:171`) — in-process Task Progress checklist. Same scope.
- The **daemon** (`apps/cli/src/daemon/server.ts:1-8`) is a code-graph / context warm-index service, **not** a turn runner. Background turns outlive the REPL via the detached **worker** (§1.2), not the daemon. No change needed here.

### 1.5 The local-triage primitive was removed — v1 routing is deterministic

This spec originally keyed mode-ON routing off `classifyPromptIntent` (`prompt-intent.ts`), the zero-cost word-match "simple" vs "task" heuristic. That module was **deliberately deleted from the REPL** (PR #893, determinism-only policy: no word-match heuristics in the harness). v1 therefore ships with **no intent triage at all**: mode ON dispatches every plain prompt, and the user keeps per-prompt inline control via the explicit `=`/`>` prefix (§2.1). An LLM triager remains a possible v2.

### 1.6 Session-observation plumbing already exists

`SessionStore` exposes everything needed to surface detached work back into the REPL:
- `watchSessions(onRoster, opts)` (`apps/cli/src/sessions/store.ts:455`) — full roster on any change, `fs.watch` + 1 s poll.
- `tailEvents(sid, onEvent, opts)` (`store.ts:410`) — sub-50 ms live event stream per session, `fs.watch` + 300 ms poll floor.
- The event envelope (`apps/cli/src/sessions/events.ts`) carries `session.start`, `stage`, `diff`, `message.end`, `turn.end`, `error`, and `session.end` (`events.ts:159-166`, includes `summary`, `usage`, `durationMs`). This is the ADR-023 public wire format — **reuse it, do not add a second transport.**

---

## 2. Recommended UX

### 2.1 Mode

Add **Dispatch mode** (async autopilot). One toggle, three ways to act:

| Input | Behavior |
|---|---|
| `/dispatch on` \| `off` \| (bare toggles) | Turns Dispatch mode on/off; persisted in tiered config. Header shows a `⇉ dispatch` indicator when on. |
| Plain prompt, **mode ON** | **Background dispatch**, composer frees immediately. Deterministic — no intent triage (§1.5); force a prompt inline with a leading `=`/`>`. |
| Plain prompt, **mode OFF** | Unchanged — runs the inline turn (today's behavior). |
| Trailing ` &` (either mode) | Always background dispatch — the existing explicit primitive, now with transcript feedback (§2.3). |
| Leading `/` or `!` | Unchanged — slash/shell commands never dispatch. |

**Why "dispatch literally everything" instead of triage:** the original design triaged with `classifyPromptIntent` so quick lookups answered inline, but that word-match heuristic was removed from the REPL (PR #893, determinism-only policy). Deterministic routing means the mode does exactly one predictable thing; a user who wants a quick inline answer types a leading `=` (or turns the mode off). The failure mode — "a lookup got dispatched" — stays visible and cancelable, never "a real task blocked the composer".

**Escape hatches:** in Dispatch mode, a leading `=` (or `> `) on a prompt forces it **inline** ("do this one right here, I'll wait"); ` &` forces it **background**. Both are pure prefix checks, no config.

### 2.2 What the user sees while N run

A **Background dispatches** panel (right dock, below/left of the existing HUD), fed by `store.watchSessions` filtered to sessions this REPL spawned. One compact row per dispatch:

```
⇉ Background (2 running · 1 done)
  ● a3f2  fix the login redirect loop        execute · 12 tools · $0.04
  ● 9b1c  add rate-limit headers to api      plan    ·  1 tool  · $0.01
  ✓ 7d40  rename Session→AgentSession         done    ·  8 files · $0.06
```

- Rows are **non-focus-stealing** — they never grab the cursor or the composer.
- Reuses the existing dock/panel layout and the `agentRegistry` rendering idiom (a new `kind: "dispatch"` is the cleanest fit; see §3).
- The composer stays exactly where it is; the user keeps typing.

### 2.3 How completions surface

The REPL subscribes to each dispatched session (`store.tailEvents(sid, …)`) and folds a **compact, attributed** line into the transcript on terminal events — the same shape as the inline fleet summary (`summarizeFleetRun`, `fleet-turn.ts:83-99`), but for detached sessions:

- On `session.end` (`events.ts:159-166`): `pushAssistant("◇ a3f2 \"fix the login redirect loop\" — done: <summary> · 3 files · $0.04")`. State `failed` → `✗`; `cancelled` → `◌`.
- On `error` with `fatal: true`: surface immediately (`✗ a3f2 failed: <message>`).
- Optional (behind a verbosity flag): fold `diff` events (`events.ts:132-137`) as one-liners so the user sees files landing live.

Crucially, these are **appended below** the transcript like any assistant message — they never interrupt an in-progress composer edit and never re-focus. This is the one genuinely new wiring: today the REPL dispatches and forgets (§1.2).

---

## 3. Minimal implementation plan

Numbered edits. Files marked **[lead]** are in `interactive.tsx` (owned by the session lead); the rest are new standalone modules.

1. **New file `apps/cli/src/repl/dispatch-mode.ts`** — pure policy + state, no React:
   - `type DispatchDecision = { kind: "inline" } | { kind: "background"; prompt: string }`.
   - `decideDispatch(text, { mode }): DispatchDecision` — returns `background` when: `parseAmpersandDispatch(text) !== null`, OR (`mode` on AND not slash/shell AND not `=`/`>`-forced-inline). Otherwise `inline`. Strip the ` &` / prefix markers in the returned `prompt`. Pure, unit-testable.
   - Co-locate `dispatch-mode.test.ts` (truth table over the matrix in §2.1).

2. **New file `apps/cli/src/repl/background-tracker.ts`** — owns observation of *our* dispatches:
   - `createBackgroundTracker({ store, cwd, onNotify, onRoster })`: holds a `Set<sid>` of sessions dispatched this REPL. `add(sid)` starts a `store.tailEvents(sid, …)` tail; on `session.end`/`error` calls `onNotify(line)`; on any state change recomputes the roster from `store.watchSessions` filtered to the tracked set and calls `onRoster(rows)`. `dispose()` stops every tail + the roster watch (mirror the cleanup hygiene in `store.ts:493-498`).
   - Cap: `maxConcurrent` (default 4, from config). `canDispatch()` returns false when the tracked running count is at the cap; the caller then either **queues locally** (preferred) or warns. This is the in-REPL enforcement the CLI lacks today (`commands/fleet.ts:331-335` only warns).
   - Co-locate `background-tracker.test.ts` with an injected fake `SessionStore` (the store is already injectable).

3. **[lead] `interactive.tsx` — mode state + `/dispatch` command:**
   - `const [dispatchMode, setDispatchMode]` + `dispatchModeRef`; seed from config (step 6). Add `/dispatch` handling in `handleSubmit` alongside the other slash commands (near `interactive.tsx:1774`).
   - Header indicator when on (reuse the existing status-line render).

4. **[lead] `interactive.tsx` — route submissions through `decideDispatch`:**
   - Factor the existing ` &` block (`interactive.tsx:1715-1743`) into a local `dispatchToBackground(prompt)` helper that calls `dispatchDetachedSession`, registers the sid with the tracker (step 2), and `pushAssistant`s the "◇ dispatched …" ack.
   - At the top of `handleSubmit` (after the `!cmd` guard, `interactive.tsx:1710-1713`), call `decideDispatch(text, { mode: dispatchModeRef.current })`. `background` → `dispatchToBackground(decision.prompt)` and `return` (frees the pump in <50 ms). `inline` → fall through to today's turn.
   - Enforce the cap: if `!tracker.canDispatch()`, keep the prompt in the FIFO (do **not** dispatch) and show `⧗ dispatch queued (cap N)`; a completing dispatch re-pumps. (Minimal alternative for v1: warn and dispatch anyway — but the local cap is cheap and is the safer default.)

5. **[lead] `interactive.tsx` — mount the tracker + render the panel:**
   - `useEffect` on mount: `const tracker = createBackgroundTracker({ store: openFleetStore(fleetRoot(cwd)), cwd, onNotify: pushAssistant, onRoster: setBackgroundRows })`; return `tracker.dispose`.
   - Render a `<BackgroundPanel rows={backgroundRows} />` in the dock. Simplest integration: give `agentRegistry` a `kind: "dispatch"` and push tracker rows through it so `/hud` shows background dispatches too — one panel, no new layout. (`agent-registry.ts:18` is the only type to widen.)

6. **Config persistence** — add `dispatchMode: boolean` (default off) and `dispatchMaxConcurrent: number` (default 4) to the tiered config the REPL already reads (`apps/cli/src/repl/config-panel.tsx` / the config store). Read at mount into `dispatchModeRef`; `/dispatch on|off` writes it back.

7. **Docs + parity:** update `oxagen fleet` help and any REPL help (`HELP` in `interactive.tsx`) to describe `/dispatch` and the `=`/`&` prefixes.

No changes to `sessions/runner.ts`, the daemon, or the fleet orchestrator are required for v1 — the mode is a **router in front of two mechanisms that already work** (§1.2, §1.3) plus the observation wiring that is the actual missing piece (§2.3).

---

## 4. Concurrency, conflict, permission & budget handling

### 4.1 File conflicts across separate dispatches — the load-bearing risk

The inline fleet's file-ownership gate (`orchestrator.ts:322-341`) and worktree isolation apply **only within one `Fleet` instance**. Two **separate** detached workers are two processes; their only shared guard is the cross-process lock-file layer of `createLocalFileLockProvider` (`local-file-lock.ts:143-156`), which is **per-file mutual exclusion on the shared `cwd`** — it stops simultaneous writes to the *same* file but not semantically conflicting edits, and it interleaves edits live in the working tree.

Two options, pick per risk appetite:

- **v1 (ship first): shared-tree + cross-process file lock (already in place).** Keep detached workers editing `cwd` directly (`runner.ts:336`). Mitigate with (a) the low concurrency cap (§3 step 2, default 4), and (b) loud surfacing — a worker that hits a held lock already degrades to a "Blocked" tool result, not corruption (`local-file-lock.ts` module doc). Document that concurrent background dispatches share one tree.
- **v2 (recommended follow-up): per-dispatch worktree isolation.** Thread an `isolate` flag through `dispatchDetachedSession` → the worker → have `runner.ts` run its `runTurn` inside a `WorktreeManager` worktree (reuse `apps/cli/src/agent/fleet/git-isolation.ts`), checkpoint + integrate on `session.end`. Then parallel background dispatches physically cannot clobber the tree; overlap becomes a **merge conflict at integration**, surfaced (not silent) exactly like the inline fleet (`orchestrator.ts:412-430`). This is the correct end state for "dispatch everything in parallel," but it is a worker-side change and should not block the UX v1.

Either way: **never auto-resolve conflicts.** Surface them in the transcript with the sid and the conflicted files, and leave the worktree for a resolver agent or human — matching the existing `keep: !conflict.ok` disposal (`orchestrator.ts:460-463`).

### 4.2 Permission prompts cannot steal focus — already handled

Detached workers have **no interactive permission broker**: `sessions/runner.ts` wires `buildTurnExtras` with `gatePermissions: true` and the tool gate owns permissions (`runner.ts:11-16` module doc). A background worker therefore **cannot pop an interactive approval** into the REPL — it operates under the non-interactive fleet policy (auto-approve within policy, or the tool is blocked and reported). This is the correct behavior for Dispatch mode and needs no new work; **document it**: background dispatches inherit the fleet permission policy, not the REPL's interactive broker, so a prompt that would need an interactive approval will be gated server-side rather than pausing for the user.

### 4.3 Budget guard across concurrent dispatches

Per-turn USD budget is enforced inside `runCodingAgent` per session/turn (per-turn-budget, PR #625). Each detached session carries its **own** budget; there is **no aggregate cap across concurrent background sessions today.** For v1: pass the session budget at dispatch time and show per-dispatch `$` in the Background panel (§2.2) so spend is visible. Call out as a known limitation that aggregate budget across parallel processes is not enforced; a v2 could sum `usage.cumulative` from the roster (`events.ts:148-152`) and stop dispatching (or warn) past an aggregate ceiling — the roster already carries the numbers.

### 4.4 Result attribution

Track only **our** sids (§3 step 2) so `watchSessions` never surfaces a stranger's session (e.g. one started from another terminal) into this transcript. Every folded line is prefixed with the short sid + title (`◇ a3f2 "…"`), matching the ack shown at dispatch time (`interactive.tsx:1732-1735`).

---

## 5. Explicitly NOT building

- **No second transport / store.** Reuse the ADR-023 session envelope and `SessionStore.watch*` (`events.ts`, `store.ts`). Do not invent a REPL↔worker channel.
- **No fleet-of-fleets by default.** A detached worker runs one `runTurn` conversation (`runner.ts`); it can already use subagent tools internally. Nesting a `Fleet` inside every worker is out of scope.
- **No daemon-hosted scheduler.** The daemon stays a code-graph/context index (`daemon/server.ts:1-8`). Dispatch mode is process-spawn + store-watch, nothing central.
- **No removal of the synchronous inline turn.** Dispatch mode is additive and default-off; forced-`=` prompts stay inline. Some work is genuinely "do it now while I watch."
- **No distributed/cross-machine locking.** The on-machine `local-file-lock` (`local-file-lock.ts`) is the ceiling; parallel dispatch is single-machine.
- **No auto-merge of conflicting worktrees** (§4.1) and **no attempt to make background permission prompts interactive** (§4.2).
- **No triage call at all.** v1 routing is deterministic (§1.5) — the word-match heuristic was removed in PR #893 and an LLM triager is a possible v2, not a v1 dependency.

---

## 6. Definition of done (v1)

- `/dispatch on` + a plain prompt frees the composer in <100 ms (dispatch is <50 ms per `sessions/dispatch.ts:64`), and the Background panel shows the running dispatch.
- A `=`-prefixed prompt in Dispatch mode still answers inline.
- Completed/failed dispatches fold an attributed one-liner into the transcript without moving the cursor.
- The concurrency cap holds: submitting more than `dispatchMaxConcurrent` tasks queues locally rather than spawning unbounded workers.
- `dispatch-mode.test.ts` and `background-tracker.test.ts` pass (narrow, co-located runs only — never the full suite).
- Config round-trips the mode + cap across REPL restarts.

---

## 7. v1 DoD verification (2026-07-20)

Audited on branch `repl-dispatch-dod`; every §6 bullet holds with evidence:

1. **Mode ON + plain prompt frees the composer** — `decideDispatch` runs at the top of `handleSubmit` (`interactive.tsx:2278-2286`): a `background` decision calls `dispatchToBackground` and `return`s before any inline-turn work; the detached spawn is "typically well under 50 ms" (`sessions/dispatch.ts:75`). The Background panel renders from the tracker roster (`interactive.tsx:4122-4134`).
2. **`=`-prefixed prompt stays inline** — precedence in `decideDispatch` (`dispatch-mode.ts:67-84`): trailing ` &` → background; mode OFF → inline; slash/shell → inline; forced `=`/`> ` → inline with the marker stripped (`dispatch-mode.ts:81`); only then background. Pinned by the 14-case truth table in `dispatch-mode.test.ts`.
3. **Completions fold back attributed, no focus steal** — the tracker's `onNotify` is wired to `pushAssistant` (`interactive.tsx:4126`), appending sid-attributed one-liners as ordinary transcript lines (`background-tracker.ts` module contract, items 1-2).
4. **The cap holds** — `dispatchToBackground` checks the resource-scaled effective cap and `tracker.reserve()` before spawning; past the cap the prompt joins `dispatchQueueRef` with a visible `⧗ dispatch queued` line (`interactive.tsx:2216-2233`); a freed slot re-drains via `onSlotFree` (`interactive.tsx:4128`, drain loop `interactive.tsx:2252`).
5. **Co-located tests pass** — `dispatch-mode.test.ts` (14) + `background-tracker.test.ts` (10): 24/24 green as narrow single-file runs. The two §1.1 FIFO queue tests were revived (see the §1.1 note): 5/5 consecutive green.
6. **Config round-trips** — `dispatchMode`/`dispatchMaxConcurrent` in `settings/schema.ts:209,215`; seeded at mount via `loadDispatchSettings` (`interactive.tsx:729-736`); `/dispatch on|off` → `persistDispatchMode` (`interactive.tsx:2341`) and `/dispatch cap <n>` → `persistDispatchCap` (`interactive.tsx:2385`), both through `writeSettingsValue` (`dispatch-settings.ts:39-56`).

Help parity (§3 step 7) landed with this audit: the REPL HELP documents the ` &`/`=` markers and the cap (`repl/components.tsx`), and `oxagen fleet --help` cross-references the mode (fleet help footer in `program.tsx`; module doc in `commands/fleet.ts`).
