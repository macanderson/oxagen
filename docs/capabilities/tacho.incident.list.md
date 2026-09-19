# list_incidents

**Capability:** `list_incidents`
**Domain:** tacho
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

The workspace's tamper and integrity incidents (MC spec App. E; #2956), newest first, keyset-paged on (`detectedAt`, id), optionally narrowed to the hosts enrolled under one agent or to open rows. The read behind the Agents detail page's incidents tab. `tacho.incidents` is the one incident store: the collector, the control plane and a person record hooks removed, chain breaks, token replays, spoofed events, telemetry gaps and the rest (`TACHO_INCIDENT_KINDS`). No mandate-exception store exists, so no such row can appear here.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string?` | Only incidents on hosts enrolled under this agent (`agt_…` or slug). |
| `open` | `boolean?` | Only unresolved incidents. |
| `limit` | `number` | 1 to 100; default 50. |
| `cursor` | `string?` | The `nextCursor` of the previous page. |

## Output

| Field | Type | Notes |
|---|---|---|
| `items[].id` | `string` | `tin_…`. |
| `items[].kind` | enum | `unobserved_session`, `hooks_removed`, `config_change`, `telemetry_gap`, `chain_break`, `checkpoint_lapse`, `token_replay`, `policy_violation`, `spoofed_event`, `daemon_down`, `otel_missing`, `unknown_model_cost`. |
| `items[].severity` | `1 \| 3 \| 10` | Notice, warning, tamper. |
| `items[].detectedAt` | `string` | ISO-8601. |
| `items[].detectedBy` | `"collector" \| "control_plane" \| "human"` | |
| `items[].hostEnrollmentId` | `string \| null` | `tch_…`; null for a control-plane finding with no host. |
| `items[].sessionId` | `string \| null` | `tse_…`; null when the incident is not on a session. |
| `items[].agentKey` | `string \| null` | The host's agent key. |
| `items[].evidence` | object | What the detector recorded. |
| `items[].resolvedAt` / `.resolutionNote` | `string \| null` | |
| `nextCursor` | `string \| null` | |

## Roles

Org Owner, Admin, Member; workspace Owner, Member.

## Side effects

None. Read-only; audit-exempt.

## Surfaces

- `POST /api/v1/{org}/{ws}/tacho/incidents`
- MCP tool `list_incidents`

## Errors

| code | meaning |
|---|---|
| `not_found` | `agentId` names no live agent in the workspace (`agent_not_found`). |

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): an incident is what the collector or the control plane detected, and an agent whose key cannot be composed has no host and no incident.
