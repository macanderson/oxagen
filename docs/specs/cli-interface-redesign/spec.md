# CLI interface redesign — implementation spec

> Contract for the `feat/cli-interface-redesign` body of work. Read with
> ADR-023 (why). This file says exactly *what* to build and *where*.

## 0. Goals (user-visible)

1. Everything works interactive **and** headless; headless output is NDJSON a
   process can pipe to another process.
2. A **fleet manager** view: many requests routed to concurrent agent
   sessions, one screen.
3. **Immediate dispatch**: submitting a prompt never blocks the composer; you
   can start a brand-new session while others run.
4. **Aggregate timeline**: all agents' messages merged into one live view.
5. Award-grade polish and performance: cold start of the fleet view < 400 ms
   to first paint; text streaming never saturates the disk (coalesced writes);
   rendering throttled like the REPL already does.

## 1. Module layout (all under `apps/cli/src/`)

| Path | Contents |
|---|---|
| `sessions/events.ts` | `SessionEvent` envelope: zod schemas + TS types + `parseSessionEvent` + `EVENT_SCHEMA_VERSION = 1` |
| `sessions/store.ts` | Filesystem store: create/append/read/tail/list/watch/inbox/clean + orphan detection |
| `sessions/runner.ts` | `SessionRunner` — wraps `runTurn` per session: emits envelope events (bus + disk), conversation loop over inbox, cancellation |
| `sessions/manager.ts` | `FleetSessionManager` — owns in-process runners (concurrency cap, queue), spawns detached workers, adopts foreign sessions from the store |
| `sessions/ids.ts` | `newSessionId()` → `s-<base36 time>-<4 rand>`; `shortSid()` |
| `sessions/paths.ts` | `fleetRoot(cwd)` → `~/.oxagen/fleet/<projectHash>/…` (projectHash = sha256 of git-root realpath, 12 hex) |
| `lib/output.ts` | Universal command output layer (§4) |
| `tui/mission-control/` | The fleet TUI (§5): `index.tsx` (app), `session-rail.tsx`, `aggregate-timeline.tsx`, `focus-transcript.tsx`, `composer.tsx`, `vitals-bar.tsx`, `aggregate-line.ts` (pure event→line formatter, unit-testable) |
| `commands/fleet.ts` | `oxagen fleet` command tree (§3) |

Existing `agent/fleet/` (task fleet for `oxagen agents`) is untouched.

## 2. The envelope (`sessions/events.ts`)

```ts
type SessionEvent = { v: 1; sid: string; seq: number; ts: number } & (
  | { type: "session.start"; title: string; prompt: string; cwd: string;
      model?: string; agent?: string; mode: "conversation" | "once";
      owner: "tui" | "worker"; pid: number }
  | { type: "session.state"; state: SessionState; reason?: string }
  | { type: "stage"; kind: StageKind; label: string; detail?: string } // engine StageEvent verbatim
  | { type: "message"; role: "user"; text: string; turn: number }      // user msgs are atomic
  | { type: "message.delta"; text: string; turn: number }              // assistant, coalesced
  | { type: "message.end"; text: string; turn: number }                // full assistant text
  | { type: "reasoning.delta"; text: string; turn: number }
  | { type: "tool.start"; name: string; input: string }                // input JSON capped 2 KB
  | { type: "tool.end"; name: string; ok: boolean; durationMs: number; result: string } // capped 2 KB
  | { type: "file.edit"; path: string; bytes: number }
  | { type: "command.run"; command: string; exitCode: number }
  | { type: "turn.end"; turn: number; steps: number; stopReason?: string;
      changedFiles: string[]; usage: TurnUsage }
  | { type: "usage"; cumulative: TurnUsage }                           // after each turn
  | { type: "error"; message: string; fatal: boolean }
  | { type: "session.end"; state: "done" | "failed" | "cancelled"; summary: string;
      durationMs: number; usage: TurnUsage }
);
type SessionState = "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";
type TurnUsage = { inputTokens: number; outputTokens: number; costUsd: number };
```

Rules:
- `seq` strictly monotonic per session, starting 1. Readers may resume with
  `fromSeq`.
- Additive evolution only; breaking → bump `v`.
- `waiting` = conversation session idle between turns (inbox open).
- Zod schema exported as `sessionEventSchema`; **golden test** pins one
  serialized sample of every type (schema-stability test).

## 3. Command surface (`commands/fleet.ts`)

```
oxagen fleet                       TTY → Mission Control TUI; non-TTY → alias of `fleet watch --json`
oxagen fleet dispatch [prompt...]  detached worker; prints sid then exits 0.
                                   "-" or empty prompt + piped stdin → read prompt from stdin.
                                   --follow  stream that session's events (NDJSON if --json/non-TTY)
                                   --once    end after first turn (default: conversation)
                                   --model/--agent passthrough
oxagen fleet ls                    roster from meta.json files (--json → one JSON array)
oxagen fleet watch [sid...]        merged live stream; no sids = all non-terminal.
                                   TTY → pretty aggregate lines; else NDJSON envelope verbatim
oxagen fleet attach <sid>          TTY → Mission Control focused on sid; else NDJSON from seq 0 + follow
oxagen fleet send <sid> <msg...>   append {type:"message"} to inbox ("-" → stdin)
oxagen fleet cancel <sid>|--all    append {type:"cancel"}; also SIGTERM the owner pid if alive
oxagen fleet logs <sid>            dump events.ndjson (--from-seq N, --follow)
oxagen fleet clean                 prune terminal sessions (--older-than 7d default, --all)
oxagen fleet worker <sid>          [hidden] the detached worker entry
```

Exit codes: 0 ok · 1 runtime error · 2 usage/validation. `dispatch --follow`
and `attach --json` exit with the session's fate (0 done, 1 failed/cancelled).

REPL graft (`repl/interactive.tsx` handleSubmit, minimal diff): a prompt
ending in `" &"` → `manager.dispatchDetached()`, transcript gets one ack line
`◇ dispatched s-xxxx — oxagen fleet to watch`, composer clears. No other REPL
changes.

## 4. Universal output layer (`lib/output.ts`)

```ts
interface Output {
  mode: "pretty" | "json" | "quiet";
  data(value: unknown, pretty?: (v: unknown) => string): void; // final result (stdout)
  event(e: object): void;      // NDJSON line (stdout, json mode only)
  info(msg: string): void;     // stderr, suppressed in quiet
  warn(msg: string): void;     // stderr
  error(err: unknown, code?: string): void; // stderr; json mode → {type:"error",code,message}
}
createOutput(opts: { json?: boolean; quiet?: boolean }): Output
// mode = json if --json OR !process.stdout.isTTY && command opted into auto-json
```

Conventions (enforced across the sweep):
- stdout carries ONLY machine/answer content; progress & decoration → stderr.
- Every command accepts `--json`; list-shaped results emit a JSON array, not
  NDJSON, unless the command is a stream (then NDJSON envelope).
- Errors in json mode: single `{"type":"error","code","message"}` line on
  stderr, non-zero exit.

Sweep: convert `commands/*.ts` to `createOutput`. Commands that already have
`--json` keep their current payload SHAPE (do not break consumers); the sweep
normalizes plumbing (stderr discipline, exit codes) and adds `--json` where
missing (a `graph.pull`-style long-runner may emit progress on stderr).

## 5. Mission Control (`tui/mission-control/`)

Layout (full-screen, alt-screen like the REPL):

```
┌ vitals: ● 3 running · 1 waiting · 2 done · $0.84 · 412k tok ─ project ┐
│ rail (left, 24-30 cols)      │ main pane                              │
│  ● s-k3x auth-fix     2:41   │  [A]ggregate | [F]ocus | [R]oster      │
│  ◐ s-k41 tests…       0:12   │  (mode-dependent content)              │
│  ✓ s-k2f readme       done   │                                        │
├──────────────────────────────┴────────────────────────────────────────┤
│ composer: always focused, never blocked                               │
│ keys: enter dispatch · @sid msg → send · tab cycle · a/f/r views · …  │
└───────────────────────────────────────────────────────────────────────┘
```

- **Aggregate** (default when >1 session): merged, per-session-colored salient
  lines — stages, tool.end (name + duration), file.edit, command.run,
  message.end (first 120 chars), session.state, errors. Text deltas are NOT
  interleaved (noise); a one-line live tail per running session sits pinned
  under the timeline. `v` toggles verbose (include deltas).
- **Focus**: one session's full transcript (markdown via existing
  `tui/markdown.tsx`), streaming live; Enter in composer sends INTO the
  focused session (follow-up turn); `esc` back to aggregate.
- **Roster**: dense table (reuse visual language of `fleet-view/agent-row`).
- Composer semantics: plain text + Enter → NEW session (immediate dispatch,
  in-process runner; composer clears instantly). `@s-k3x fix the test` →
  follow-up to that session. In Focus mode plain Enter = follow-up to focused.
- Keys: `tab`/`shift-tab` cycle sessions · digits 1-9 jump · `a/f/r` views ·
  `v` verbose · `c` cancel selected (confirm) · `n` new (clears @focus) ·
  `ctrl-c` quit (sessions keep running detached? NO — in-process runners drain
  like FleetApp; detached/adopted sessions are unaffected; show drain state).
- Foreign sessions (dispatched from other terminals) appear automatically via
  store watch (≤1 s), read-only + inbox control (send/cancel work).
- Rendering: reuse `repl/render-throttle.ts` pattern; timeline keeps last
  500 lines in state (older lines dropped — the disk log is the archive).

## 6. Engine touch (additive only)

`RunTurnOptions.onEvent?: (e: CodingEvent) => void` — forward the engine's
`CodingEvent`s (tool-result detail, file-edit, command, final-diff) verbatim
from inside the pipeline's existing `onEvent` translation sites (3 call sites:
main loop, revise loop, bare mode). Today's `onText`/`onToolCall` remain.
Unit test in `packages/agent-engine` asserts forwarding.

## 7. Session semantics

- Runner uses the SAME wiring as one-shot/fleet: `buildTurnExtras` (+
  `gatePermissions: true` — no interactive permission broker inside fleet
  sessions v1), `createMeteredAi(createGatewayAgentAi)` or platform port,
  memory recall as in `engine-runner.ts`.
- Conversation loop: after `turn.end`, state → `waiting`, tail inbox; a
  `message` starts the next turn with threaded `history` (from
  `RunTurnResult.messages`). `cancel` → abort + `session.end(cancelled)`.
  Idle timeout (default 30 min, `--idle-timeout`) → `session.end(done)`.
- Worker process: `fleet worker <sid>` reads meta (prompt, options), runs the
  runner, exits with the session's fate. Spawned `detached: true,
  stdio: "ignore"`, `unref()`.
- Concurrency: manager cap default 4 (`--concurrency`, config
  `fleet.concurrency`); excess sessions state=`queued`, started FIFO.
  Detached workers are NOT capped by the manager (the OS is their cap), but
  `dispatch` warns on >8 alive.

## 8. Tests (vitest, poll-based `until()` helpers for Ink — never sleeps)

- `sessions/__tests__/events.test.ts` — golden envelope samples, zod
  round-trip, additive-only guard (type snapshot).
- `store.test.ts` — tmpdir: append/read/tail (fromSeq), meta atomic replace,
  inbox append/consume, orphan detection (fake dead pid), clean.
- `runner.test.ts` — fake runTurn: event order (start→stage→…→turn.end→
  waiting), follow-up threads history, cancel mid-turn, once-mode.
- `manager.test.ts` — cap + queue, immediate sid return, adoption of foreign
  meta, detached spawn (spawn mocked).
- `aggregate-line.test.ts` — pure formatter: every event type → expected line.
- `mission-control` ink tests — dispatch from composer paints a rail row;
  @sid routes to inbox; view switching.
- `commands/__tests__/fleet.test.ts` — dispatch prints sid; ls --json parses;
  watch non-TTY emits envelope lines (fake store).
- Engine: onEvent passthrough test.
- NO full-suite runs; run each new file individually.

## 9. Docs

- `apps/docs` CLI section: new "Fleet" page (concepts: session, event log,
  aggregate view; the NDJSON contract with a jq cookbook) + "Scripting the
  CLI" page (dual-mode conventions, exit codes, envelope reference).
- Update `apps/cli/README.md` command table.

## 10. Out of scope (v1)

- Plan-DAG dispatch into the session fleet (stays on `oxagen agents`).
- Cross-machine fleets; Windows first-class support.
- Interactive permission prompts inside fleet sessions (tool gate owns it).
- Resume-after-crash of the exact ModelMessage history (transcript survives;
  conversation context does not).
