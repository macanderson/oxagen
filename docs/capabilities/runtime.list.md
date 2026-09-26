# list_runtimes

**Capability:** `list_runtimes`
**Domain:** runtime
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

The runtimes named in the workspace, in name order, each with its live agents and their harness, its live host enrollments, and when a host last reported (ADR-192, #4369).

The register form reads this to keep a runtime and harness pair from being registered twice. It disables a runtime that already runs the chosen harness, and a harness the chosen runtime already runs, and names the agent that holds the pair. A retired agent frees its pair and is not listed.

## Input

None (`{}`).

## Output

| Field | Type | Notes |
|---|---|---|
| `items[].id` | `string` | `rtm_…`. |
| `items[].name` | `string` | |
| `items[].slug` | `string` | |
| `items[].createdAt` | `string` | ISO-8601. |
| `items[].agents[]` | object | `id` (`agt_…`), `name`, `slug`, `harness` of each live agent on the runtime, at most 16. |
| `items[].liveHosts` | `number` | Host enrollments bound to the runtime that are not revoked. |
| `items[].lastSeenAt` | `string \| null` | The newest `last_seen_at` among its hosts; null when none has reported. |

At most 500 runtimes.

## Roles

Org Owner, Admin; workspace Owner, Member, Viewer.

## Side effects

None. Read-only; audit-exempt.

## Surfaces

- `POST /api/v1/{org}/{ws}/runtimes`
- MCP tool `list_runtimes`
