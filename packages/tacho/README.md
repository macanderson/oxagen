# @oxagen/tacho

Tacho is the Oxagen wrapper that records, gates, and evidences agents Oxagen
does not run itself: Claude Code, Claude Agent SDK agents, and custom agents.
Spec: `docs/specs/tacho/spec.md`. Column contract: `docs/specs/tacho/data-model.md`.

This package is a leaf: no `@oxagen/*` runtime dependency, so it can publish
on its own. What is here today (plan PR 1):

| Module | What it is |
|---|---|
| `envelope.ts` | The `tacho/1.0` event schema: one envelope, a typed body per kind, strict, with every body member named as its ClickHouse column |
| `chain.ts` | Per-session hash chain: seal with dense `seq`, `prev_hash`, `hash`; verify a slice |
| `columns.ts` | The mechanical flattening of an event into a `tacho_events` row |
| `ids.ts`, `digest.ts`, `timestamp.ts` | Deterministic identity (UUIDv5, idempotency ids, effect ids, ULIDs), RFC 8785 digests, the CGP timestamp profile |
| `claude-code/` | Pure normalizers for Claude Code hook payloads, its OpenTelemetry export, session transcripts, and the headless result stream, plus the recorder that seals them into parent and subagent chains |
| `trace/` | The `contextgraph-trace` journal vocabulary, its strict parser, a port of the eight replay oracles, and the projection from Tacho events onto the journal |

Fixtures under `fixtures/claude-code/` are a scrubbed real Claude Code 2.1.263
session captured with hooks on every event and the OTLP exporters pointed at a
local receiver; `claude-code/replay.test.ts` drives them through the recorder
and requires the chains to verify, every row to hit a known column, and both
the parent and subagent journals to pass the oracles. Fixtures under
`fixtures/contextgraph-trace/` are pinned byte for byte to the upstream crate
(`pnpm check:tacho-fixtures`).

Not here yet: the collector daemon, the hook binary, enrollment, the control
plane capabilities, and the SDK adapters. See `docs/specs/tacho/plan.md`.
