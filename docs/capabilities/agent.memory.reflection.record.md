# record_reflection

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** mcp
**Risk level:** low

## Intent

The memory an agent writes at the end of a run. It gives the outcome, a summary, a grade from 1 to 5 for the work and for each tool, the lessons worth keeping, and any problem with a tool. The call writes nothing. When the run seals, `run.reflect` reads the call from the run's record, checks it against this contract, and stores a `reflection/v1` with the agent and run Oxagen recorded (ADR-206). Each lesson becomes a `memory/v1` the curator may propose.

The tool grades and tool feedback go to each tool server's owner. They never steer an agent.

Claude Code asks for this call at the first stop of a run that showed a signal: a failed tool call, a correction, a retry loop, or a policy denial. For a run that did not call it, `run.reflect` writes the reflection from the run's digest.

## Input

| Field | Type | Notes |
|---|---|---|
| `outcome` | `completed \| failed \| cancelled \| crashed \| unknown` | How the run ended. |
| `summary` | `string` (1–2000) | What the run did, in one paragraph. |
| `grades.work` | `int 1–5` | The work on the task. |
| `grades.tools` | `record<string, int 1–5>` | A grade per tool, by the name the agent saw. Oxagen maps each to `<server>__<tool>` and drops built-in tools. |
| `lessons` | lesson[] (≤50) | Each has the fields of `remember_lesson`. |
| `tool_feedback?` | `{ tool, problem }[]` (≤50) | What was wrong with a tool or its description. |

## Output

| Field | Type | Notes |
|---|---|---|
| `status` | `"noted"` | The call was accepted. The reflection is stored when the run seals. |
| `message` | `string` | What happens next, in one sentence. |

## Roles

Org Owner, Org Admin, Org Member, Workspace Owner, Workspace Member.

## Side effects

None at call time. `run.reflect` writes an `agent.memory_reflections` row, and an `agent.memories` row per lesson, when the run seals.
