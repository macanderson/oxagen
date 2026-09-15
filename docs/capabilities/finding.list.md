# finding.list

The workspace's costed findings ranked by the money at stake, with the totals the Spend page leads with (Mission Control spec §12.8, App. E; ADR-062). Every figure is the findings job's: a saving is measured minus counterfactual over the runs the finding cites, at the price each run paid, with the confidence the job assigned.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/spend/findings`
- MCP: `list_findings`
- Authentication: session (org Owner, Admin, Billing or Member; workspace Owner or Member)
- Capability name: `list_findings`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `status` | enum | no | `open` (default), `applied` or `dismissed` |

## Output

| Field | Type | Description |
|---|---|---|
| `status` | enum | as asked |
| `window` | object or null | `{ from, to }`, the span the listed findings cover; null when none is listed |
| `saving` | cost or null | the listed findings' savings summed, with the fold of their bases |
| `spend` | cost or null | the workspace's priced spend on runs that started in `window`; null when nothing in it was priced |
| `share` | number or null | `annualised` over `spend` scaled from `window` to 365 days, at most 1; a `window` shorter than 7 days scales as 7 days |
| `annualised` | cost or null | each listed finding's saving scaled from its own window to 365 days, summed; a window shorter than 7 days scales as 7 days, so a finding re-proven minutes after a decision is not scaled from minutes to a year |
| `counts` | object | `{ findings, high, medium, operators }`; `operators` counts the distinct operators whose runs the listed findings cite |
| `findings` | object[] | at most 50; open findings largest saving first, decided findings most recent decision first |

Each finding carries `id` (`fnd_…`), `kind`, `level`, `subject`, `saving` (cost), `confidence` (`high` or `medium`), `window`, `why`, `fix`, `runs` and `calls` (what it cites), `status`, `detectedAt`, `decidedAt` and `appliedActionId`.

## Kinds

| Kind | Level and subject | Counterfactual |
|---|---|---|
| `cache_writes_never_read` | operator (`prn_…`), or the agent when the run names no operator | the written prefix sent uncached |
| `repeated_shell_commands` | tool `Bash` | the earlier identical result, already in the run |
| `duplicate_tool_calls` | agent | the earlier identical result of a read-only tool, already in the run |
| `unpaged_results` | tool | the same result capped at 4,000 tokens |

ADR-062's detector table has the detection rule, the rollup and frame fields each kind reads, and the §12.8 rows that wait on a recorder.
