# ADR-023 — CLI fleet: sessions as append-only event logs, views as renderers

- **Status:** Accepted
- **Date:** 2026-07-06
- **Owners:** CLI
- **Relates to:** ADR-016 (CLI daemon), ADR-019 (unified agent engine), ADR-021 (inference doctrine)

## Context

The CLI grew four disconnected interaction surfaces, each with its own output
dialect:

1. The **REPL** (`oxagen`) — one interactive session, Ink-rendered, no
   machine-readable twin.
2. **One-shot** (`oxagen "prompt"`) — `text` / `json` / `stream-json` output
   formats with clean stdout/stderr discipline, but a private event vocabulary
   (`{type:"text",delta}` …) used nowhere else.
3. The **agents screen** (`oxagen agents`) — a fleet of one-shot *tasks* with a
   JSONL headless twin, again with its own vocabulary (`{type:"task",…}`), no
   full transcripts (2 000-char log tails), and no way to talk to an agent
   after dispatch.
4. **Subcommands** — ~33 command modules with per-command `--json` flags of
   varying shape and coverage.

None of these can do what users of an agentic CLI actually need at fleet
scale: dispatch work and immediately dispatch more without waiting; watch
*all* agents' messages in one aggregated view; follow up with a running agent;
pipe any of it between processes as JSON; or observe from a second terminal a
fleet started in a first.

## Decision

**Every unit of agent work is a *session*. Every session appends a totally
ordered stream of typed *events* to disk. Every surface — the interactive TUI,
`--json` pipes, a second terminal, a jq script — is a *view* over the same
event streams.**

Concretely:

1. **One wire format.** A versioned envelope (`SessionEvent`, `v:1`) with
   `sid` / `seq` / `ts` / `type` and a closed set of event types
   (`session.*`, `stage`, `message.*`, `tool.*`, `file.edit`, `command.run`,
   `usage`, `turn.*`, `error`). Zod-validated; golden-tested for schema
   stability. All new machine output speaks this envelope; NDJSON, one event
   per line.

2. **Sessions live on disk, not in a process.** Project-scoped store at
   `~/.oxagen/fleet/<projectHash>/sessions/<sid>/`:
   - `meta.json` — atomically-replaced snapshot (state, pid, owner, usage,
     title, timestamps) for cheap rosters;
   - `events.ndjson` — the append-only event log (the transcript IS the log);
   - `inbox.ndjson` — an append-only control channel; anyone may append a
     `{type:"message"}` follow-up or `{type:"cancel"}`; only the owning
     process consumes it.

   Any process can list, tail, and aggregate sessions it does not own.
   Ownership (who runs the engine loop) is recorded as `pid` + heartbeat;
   a dead owner with non-terminal state renders as `orphaned` at read time.

3. **Interactive and non-interactive are the same program.** The engine run is
   wrapped once (`SessionRunner`) and emits envelope events to an in-process
   bus *and* the disk log. The Ink Mission Control renders the bus; `--json`
   serializes it; `fleet watch` in another terminal tails the disk. Parity is
   a property of the architecture, not a feature to maintain.

4. **Dispatch is immediate, always.** `dispatch` returns a `sid` synchronously.
   In the TUI the session starts in-process; from a script it spawns a
   detached worker (`oxagen fleet worker <sid>`, hidden) so the dispatching
   process can exit. The composer is never blocked by a running session.

5. **Conversation over one-shot.** Sessions are conversational by default:
   after a turn settles, the runner tails its inbox for follow-ups and threads
   `history` through `runTurn`. `--once` restores fire-and-forget semantics
   for scripts.

## Alternatives considered

- **Host sessions in the existing daemon** (ADR-016). Rejected for the fleet
  path: the daemon is a warm-cache sidecar with an idle timeout; making it the
  broker for live agent work puts a mandatory socket hop and a lifecycle
  manager between the user and their agents, and a daemon crash would take the
  whole fleet down. The disk log needs no broker; the daemon can later *index*
  it.
- **In-process fleet only** (status quo of the agents screen). Rejected: kills
  cross-process observation and script dispatch, and ties session lifetime to
  the TUI's.
- **A second transport for the TUI** (rich in-proc objects, thin JSON twin).
  Rejected: that is exactly the drift that produced three vocabularies today.

## Consequences

- The agents screen's task fleet (`agent/fleet/`) remains for planned DAG
  execution; the session fleet (`src/sessions/`) is the new general surface.
  The two share the engine loop (`runTurn`) and the git-isolation machinery.
- Event logs are bounded by coalescing text deltas (~150 ms flush to disk) and
  capping tool payloads; `fleet clean` prunes terminal sessions.
- The envelope is a public contract: consumers may pin `v`; additive fields
  only; a breaking change bumps `v` and is a migration.
- Windows support is best-effort (detached spawn + fs.watch differences);
  macOS/Linux are first-class, matching the CLI's audience today.
