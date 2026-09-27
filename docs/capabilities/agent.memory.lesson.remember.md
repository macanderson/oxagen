# remember_lesson

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** mcp
**Risk level:** low

## Intent

An agent keeps one lesson from the run it is in. The call writes nothing. When the run seals, `run.reflect` reads the call from the run's record, checks it against this contract, and stores a `memory/v1` with capture `remember`. Oxagen takes the agent and the run from the run it watched, never from the tool input. The curator may later propose the lesson as a steering record in a memory PR (ADR-206).

A call Oxagen denied, or one that failed, is never stored. A caller with no watched run behind it gets an error, because there is no run to attribute the lesson to.

## Input

| Field | Type | Notes |
|---|---|---|
| `statement` | `string` (1–2000) | The lesson, written as advice for the next run. |
| `kind` | record kind | What the lesson would be as a steering record. Defaults to `memory`. |
| `repos?` | `string[]` (1–20) | Repositories, as `<host>/<owner>/<name>` in lowercase. |
| `applies_to?` | `string[]` (1–20) | Path globs the lesson applies to. |
| `tools?` | `string[]` (1–20) | Tools the lesson is about, as `<server>__<tool>`. |
| `evidence` | `int[]` (≤20) | Frame numbers in this run. Empty means Oxagen cites the frame of this call. |

## Output

| Field | Type | Notes |
|---|---|---|
| `status` | `"noted"` | The call was accepted. The lesson is stored when the run seals. |
| `message` | `string` | What happens next, in one sentence. |

## Roles

Org Owner, Org Admin, Org Member, Workspace Owner, Workspace Member.

## Side effects

None at call time. `run.reflect` writes an `agent.memories` row from the run's record when the run seals.
