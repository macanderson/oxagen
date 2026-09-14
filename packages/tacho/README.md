# @oxagen/tacho

Tacho is the Oxagen wrapper that records, gates, and evidences agents Oxagen
does not run itself: Claude Code, Codex CLI, Claude Agent SDK agents, and
custom agents. Spec: `docs/specs/tacho/spec.md`. Column contract:
`docs/specs/tacho/data-model.md`. The desktop app that installs it:
`docs/specs/oxagen-desktop/spec.html`.

This package is a leaf: no `@oxagen/*` runtime dependency, so it publishes on
its own with three executables — or, compiled, as one multi-call binary (see
[Building the executables](#building-the-executables)). The one list it shares
with the control plane by copy rather than import is `TACHO_RUNTIMES`
(`src/envelope.ts`), the values `agent.runtime` may take;
`packages/database/src/schema/tacho.ts` holds the same list for the
`tacho.sessions.runtime` CHECK, and `packages/handlers/src/tacho.runtimes.test.ts`
fails if they drift. Each harness maps to its own runtime (`contextForHarness`
in `src/collector/registry.ts`): Claude Code to `claude-code`, Codex to `codex`.

## Enrolling a machine

```
oxagen login                      # once, on the machine
oxagen tacho enroll               # or: npx @oxagen/tacho enroll --token ... --org ... --workspace ...
oxagen tacho status
oxagen tacho verify               # one headless claude turn, confirmed chained
oxagen tacho reassign --workspace other   # move the host; keeps the device key
oxagen tacho unenroll
```

`enroll` generates an Ed25519 device key, calls `create_tacho_enrollment`,
writes `~/.config/oxagen/tacho/host.json` (0600) with the host API key and the
signed policy bundle, installs `tachod` as a launchd agent, a systemd user
unit, or a per-user Task Scheduler task, and merges Tacho's hook entries into
each harness named by `--harness` (`claude-code`, `codex`, or both; default
`claude-code`) without touching any entry it did not write. From that point
every session of those harnesses on the machine is chained and shipped.

`reassign --org … --workspace …` points the host at another workspace or org.
The host API key is minted for the workspace at enrollment, so a move is a
revoke plus a fresh enrollment done as one step: revoke, strip the old
enrollment's hook groups from both harnesses, enroll again with `--force`
keeping the device key, the loopback port and the local bearer, so the fleet
page sees one continuous host. `reassign --harness claude-code,codex` with no
target re-enrolls in place, which is the one way to drop a wrapper: `enroll`
may add a harness on a re-apply but never silently removes one.

### Codex

Codex CLI exposes a near clone of Claude Code's hook surface, so the adapter
(`src/host/codex-writer.ts`) is a settings writer and a harness tag, not a new
protocol: the same `{hooks: {Event: [{matcher, hooks: [...]}]}}` shape in
`~/.codex/hooks.json` (`CODEX_HOME`), the same five enforcement events as
command hooks, the same decision field. Codex has only `command` hooks and no
env block, so its telemetry events (`PostToolUse`, `SubagentStart`,
`SubagentStop`, `PreCompact`, `PostCompact`, `SessionEnd`, `Interrupt`) run
the hook too and there is no OpenTelemetry export. The hook command carries
`--harness codex`; sessions are labelled `agent.harness = codex`,
`runtime = codex`. `transcript_path: null` is accepted, and `unenroll` strips
the Codex hooks whether or not `host.json` still lists the harness.

### Windows

The same `~/.config/oxagen` root, so the CLI and the desktop app read one set
of files on every platform. The service is a per-user Task Scheduler task
(`schtasks /Create /SC ONLOGON /RL LIMITED`, then `/Run`) that launches a
rendered `tachod.cmd`, because Task Scheduler carries no environment. The
hook posts to `127.0.0.1:<port>` with the local bearer; the daemon skips the
Unix socket. Harnesses are found with `where claude` / `where codex`, hook
command lines are double-quoted for `cmd.exe`, and paths go through
`path.win32` so a macOS test can describe a Windows layout.

## What runs on the host

| Executable | Role |
|---|---|
| `tachod` (`src/collector/`) | The collector. Listens on a Unix socket and `127.0.0.1:<port>` with a per-install bearer; normalizes hooks, OTLP, and spool replays into per-session hash chains; appends to an NDJSON WAL; ships batches to `ingest_tacho_events` at least once with backoff and bisection; applies operator commands from the control envelope; watches for hooks removed and transcripts that advance with no hook stream; signs chain-head checkpoints with the device key; continues every chain across a restart from `daemon.json` |
| `tacho-hook` (`src/claude-code/hook-main.ts`) | The command hook Claude Code runs on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, and `Stop`. Hands the payload to the daemon over the socket inside a 50 ms connect budget; if the daemon is down it decides from the cached, signature-verified bundle, spools the event, and still answers, so enforcement never depends on the daemon |
| `tacho` (`src/cli/`) | `enroll`, `status`, `reassign`, `unenroll`, `export` (tacho NDJSON, `contextgraph-trace` journal, OTLP JSON), `verify`, `daemon`, `hook` |

Telemetry-only events (`PostToolUse`, `SubagentStart`, `SessionEnd`, and the
rest of the 28 http events) post straight to the daemon; a failure there is
recorded as a chained `telemetry_gap`, never as a blocked action.

## Honesty

Hook-based control is `client_attested` (ADR-040 §4): the hook returns a
decision that Claude Code honours; nothing here prevents a process that
bypasses the hooks. That is why the detector exists and why the session record
carries `enforcement_tier`. Managed settings (`enroll --print-managed`) lock the
hooks for MDM-managed machines; the record is still labelled `client_attested`.

## Modules

| Module | What it is |
|---|---|
| `envelope.ts`, `chain.ts`, `columns.ts`, `ids.ts`, `digest.ts`, `timestamp.ts` | The `tacho/1.0` event schema, the per-session hash chain, the `tacho_events` row flattening, deterministic identity, RFC 8785 digests, the CGP timestamp profile |
| `wire.ts` | The documents that cross between host and control plane: policy bundle, enrollment claims, batch, control envelope, commands. `packages/oxagen` re-exports these for its contracts |
| `host/` | Host primitives: paths, `host.json`, the device key, offline bundle verification and the ordered `PreToolUse` evaluation over Claude Code rule syntax, the WAL, the Claude Code settings writer and the Codex hooks writer, launchd / systemd / Task Scheduler units, process scan, the control-plane client |
| `claude-code/` | Pure normalizers for hook payloads, the OpenTelemetry export, transcripts, and the headless result stream; the recorder that seals them into parent and subagent chains (restorable across restarts); the `tacho-hook` client |
| `collector/` | `handleHookEvent`, the session registry, the listener, the shipper, the command inbox, the detector, the exporters, and `startDaemon` that composes them |
| `cli/` | The `tacho` commands behind an injectable `CliDeps` port; `native.ts` is the compiled binary's multi-call entry |
| `trace/` | The `contextgraph-trace` journal vocabulary, its strict parser, a port of the eight replay oracles, and the projection from Tacho events |

## Tests

`pnpm --filter @oxagen/tacho test:unit`. The recorded Claude Code 2.1.263
session under `fixtures/claude-code/` drives the hook contract test (every
event through `handleHookEvent`, decisions per the spec table, chains verify)
and the daemon end-to-end test (real socket and port, fake control plane,
commands, daemon-down spool and replay, restart). `src/bench/` prints the
latency figures recorded in `docs/specs/tacho/plan.md`.

## Building the executables

```
pnpm --filter @oxagen/tacho bundle          # dist-standalone/{tacho,tachod,tacho-hook}.mjs
pnpm --filter @oxagen/tacho publish:standalone
pnpm --filter @oxagen/tacho compile         # dist-bin/tacho: one self-contained executable
```

### The compiled binary

A `.dmg` cannot assume Node, so `compile` bundles the CLI to CommonJS and
embeds it in a copy of the running `node` with Node's single-executable
support (`tools/sea/compile.mjs`: blob, copy, strip the Apple signature,
postject, ad-hoc re-sign; on Windows inject only). The host node is the
runtime that ships, so each OS builds its own; there is no cross-compile.
One binary weighs about 120 MB.

The result is one multi-call binary rather than three: `tacho daemon` is the
service body and `tacho hook` the command hook, dispatched in
`src/cli/native.ts` before commander is built because the hook runs on every
tool call (cold start about 111 ms, the same process-start cost as the
separate `.mjs`; the 50 ms budget is the time allowed to *reach* the daemon).
`runtimeCommands` writes `<bin>/tacho hook` and `[<bin>/tacho, daemon]`
whenever it finds that layout — inside the desktop app bundle, in a Homebrew
prefix, or in a `TACHO_BIN_DIR` the app points it at.

### The desktop app

`apps/desktop` (Tauri 2) ships this binary and the compiled `oxagen` CLI as
sidecars, signs the machine in, enrolls it, and manages the workspace and
the wrappers by running these same commands; it owns no state of its own.
`.github/workflows/desktop.yml` builds one job per OS and attaches the
bundles and the bare binaries (with `.sha256` files) to a `desktop-v<version>`
release; `tools/packaging/` holds the Homebrew and Scoop templates that
install from those assets.

Not here yet: elevation through the control plane with Biscuit tokens (plan
PR 6), the Claude Agent SDK and custom-agent adapters (PR 5).
