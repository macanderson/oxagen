# get_work_priorities

Read the priorities record triage ranks work by, and how triage has fared in the workspace over the last 30 days (lane P1-03, #5103).

**Surfaces:** api, mcp

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/priorities/get`, returns 200
- MCP: `get_work_priorities`
- Authentication: org Owner or Admin, or workspace Owner, Member, or Viewer, checked by the handler
- Billing: `noBillingGate: true`
- Not on the agent surface.

## Input

None.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `record` | object or `null` | The lineage, the record id, the version triage reads, its `sha256:` hash, the numbered rules, and when the version was published |
| `problem` | `string` or `null` | Why triage cannot rank work, when there is no single priorities record |
| `last_30_days` | object | Triage suggestions, failures, and corrections in the last 30 days |

## Semantics

The priorities record is the workspace's active steering record whose lineage is `work.priorities` or ends in `.work.priorities`, such as `aintel.work.priorities`. Its rules are numbered `1.`, `2.`, and on, each at the start of a line, and triage cites them as `<lineage>#<number>`. A person edits the record with a Context PR (`open_context_pr`), and triage reads each new version after the PR merges. Each triage decision stores the hash of the version it read. With no such record, or more than one, triage records a failure on each item it reads, and `problem` says what to fix.
