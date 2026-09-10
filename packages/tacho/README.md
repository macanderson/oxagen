# @oxagen/tacho

Tacho is the Oxagen wrapper that records, gates, and evidences agents Oxagen
does not run itself: Claude Code, Claude Agent SDK agents, and custom agents.
Spec: `docs/specs/tacho/spec.md`. Column contract: `docs/specs/tacho/data-model.md`.

This package is a leaf: no `@oxagen/*` runtime dependency, so it publishes on
its own with three executables.

## Enrolling a machine

```
oxagen login                      # once, on the machine
oxagen tacho enroll               # or: npx @oxagen/tacho enroll --token ... --org ... --workspace ...
oxagen tacho status
oxagen tacho verify               # one headless claude turn, confirmed chained
oxagen tacho unenroll
```

`enroll` generates an Ed25519 device key, calls `create_tacho_enrollment`,
writes `~/.config/oxagen/tacho/host.json` (0600) with the host API key and the
signed policy bundle, installs `tachod` as a launchd agent or systemd user
unit, and merges Tacho's hook entries and OpenTelemetry env block into
`~/.claude/settings.json` without touching any entry it did not write. From
that point every Claude Code session on the machine is chained and shipped.

## What runs on the host

| Executable | Role |
|---|---|
| `tachod` (`src/collector/`) | The collector. Listens on a Unix socket and `127.0.0.1:<port>` with a per-install bearer; normalizes hooks, OTLP, and spool replays into per-session hash chains; appends to an NDJSON WAL; ships batches to `ingest_tacho_events` at least once with backoff and bisection; applies operator commands from the control envelope; watches for hooks removed and transcripts that advance with no hook stream; signs chain-head checkpoints with the device key; continues every chain across a restart from `daemon.json` |
| `tacho-hook` (`src/claude-code/hook-main.ts`) | The command hook Claude Code runs on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, and `Stop`. Hands the payload to the daemon over the socket inside a 50 ms connect budget; if the daemon is down it decides from the cached, signature-verified bundle, spools the event, and still answers, so enforcement never depends on the daemon |
| `tacho` (`src/cli/`) | `enroll`, `status`, `unenroll`, `export` (tacho NDJSON, `contextgraph-trace` journal, OTLP JSON), `verify`, `daemon` |

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
| `host/` | Host primitives: paths, `host.json`, the device key, offline bundle verification and the ordered `PreToolUse` evaluation over Claude Code rule syntax, the WAL, the settings writer, launchd/systemd units, process scan, the control-plane client |
| `claude-code/` | Pure normalizers for hook payloads, the OpenTelemetry export, transcripts, and the headless result stream; the recorder that seals them into parent and subagent chains (restorable across restarts); the `tacho-hook` client |
| `collector/` | `handleHookEvent`, the session registry, the listener, the shipper, the command inbox, the detector, the exporters, and `startDaemon` that composes them |
| `cli/` | The `tacho` commands behind an injectable `CliDeps` port |
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
```

Not here yet: elevation through the control plane with Biscuit tokens (plan
PR 6), the Claude Agent SDK and custom-agent adapters (PR 5).
