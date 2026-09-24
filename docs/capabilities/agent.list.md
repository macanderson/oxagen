# list_agents

**Capability:** `list_agents`
**Domain:** agent
**Mode:** sync
**Scope:** org + workspace (the tenant scope the caller enters)
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`; a console read is never a governed action, ADR-052 exclusion 2)

## Intent

The identities table of the Agents page (MC spec §6.2, App. E; #2956): one row per agent registered in the workspace, ordered by slug and cursor-paged, plus the stat tiles over the whole workspace. The identity half comes from Postgres — the `agent.agents` row, its delegated `iam.principals` row (`principalId`), the person it acts for (`operatorId`, the principal's `parent_user_id`) and the harness recorded at registration — and the enrollment facts that make it revocable: active long-lived credentials (`auth.api_keys` with scope purpose `agent_credential_v1`) and live `tacho.hosts` under its agent key.

Every figure is counted from a store that exists or is `null` with the reason on the contract field. No rollup table is migrated, so the 30-day figures are counted from the run stores directly: `runs30d` from `agent.agent_runs` and root `tacho.sessions`; `spend30d` from the priced wrapped sessions as the harness reported them (`basis: "client_attested"`), `null` when no session in the window carries a priced basis. `mandates` counts the active mandates the agent's principal holds in `tools.mandates` (status `active`, inside the validity window), and `totals.holdingMandate` counts the workspace's agents that hold at least one. `enforcementTier` is the tier the agent's latest root wrapped session recorded (`tacho.sessions.enforcement_tier`, derived at ingest from the control plane's own records), null when none was recorded. `tier`, `beltSize` and `proven30d` are `null`: no store records a model tier on the identity, the belt is computed per agent by `get_agent_toolbelt`, and no verification store exists. Nothing prints a zero it did not count (ARCHITECTURE.md §3.4).

`status` is derived on the read: `retired` when the agent row is archived (`retire_agent`), `suspended` when its principal is suspended (`suspend_agent`), `enrolled` when it holds an active credential or a live host, `unenrolled` otherwise.

## Input

| Field | Type | Notes |
|---|---|---|
| `limit` | `number` | 1 to 100; default 50. |
| `cursor` | `string?` | The `nextCursor` of the previous page. A cursor this capability did not mint starts over at the first page. |

## Output

| Field | Type | Notes |
|---|---|---|
| `items[].id` | `string` | `agt_…`. |
| `items[].slug` | `string` | The definition file name and the last segment of the agent key. |
| `items[].name` | `string` | |
| `items[].description` | `string \| null` | What the agent is for, from `agent.agents.description`. |
| `items[].agentKey` | `string \| null` | `org_ns.ws_ns.slug` (ADR-024); null until the namespaces are backfilled. |
| `items[].harness` | `"stella" \| "claude-code" \| "codex" \| "cursor" \| "claude-agent-sdk" \| "custom"` | |
| `items[].principalId` | `string \| null` | `prn_…`; null on a row that predates Agent RBAC. |
| `items[].operatorId` | `string \| null` | `usr_…` of the person the agent acts for. |
| `items[].operatorName` | `string \| null` | That person's display name (`auth.users.display_name`); null when there is no operator or they set none. |
| `items[].status` | `"unenrolled" \| "enrolled" \| "suspended" \| "retired"` | Derived as above. |
| `items[].tier` | `null` | Not recorded on the identity. |
| `items[].enforcementTier` | `"contained" \| "gateway" \| "harness" \| "observe" \| null` | The tier the latest root wrapped session recorded; null when none was recorded. |
| `items[].beltSize` | `null` | Computed per agent by `get_agent_toolbelt`. |
| `items[].runs30d` | `number` | Ledger runs plus root wrapped sessions started in the last 30 days. |
| `items[].spend30d` | `Cost \| null` | `{ micros, currency, basis: "client_attested" }` or null when no priced session is in the window. |
| `items[].tokens30d` | `object \| null` | `{ total, input, cacheRead, cacheReadRate, sessions }` over the root wrapped sessions started in the last 30 days, as the harness reported usage (`tacho.sessions`). `input` is fresh input plus cache read plus cache written; `total` adds the output; `cacheReadRate` is cache read over input, null when no input was reported. Null when no session in the window reported a token. Ledger runs' tokens are metered in ClickHouse and are not in this total. |
| `items[].proven30d` | `null` | No verification store. |
| `items[].mandates` | `number \| null` | Active mandates the principal holds; null only on a row with no principal. |
| `items[].incidents` | `number` | Open `tacho.incidents` rows on the agent's hosts. |
| `items[].tamperIncidents` | `number` | Those of a tamper kind, the set `totals.tamperIncidents` sums. |
| `items[].tamperIncidentsRecorded` | `number` | Every incident of a tamper kind on the agent's hosts that the store keeps, open or resolved; the set `totals.tamper.recorded` sums. |
| `items[].credentials` | `number` | Active long-lived credentials. |
| `items[].hosts` | `number` | Live (active or paused) hosts under the agent key. |
| `items[].host` | `string \| null` | The hostname of the live host seen most recently; null when none is live. |
| `items[].registeredAt` | `string` | ISO-8601. |
| `nextCursor` | `string \| null` | |
| `totals.identities` | `number` | Live agents in the workspace. |
| `totals.enrolled` | `number` | Of those, `enrolled`. |
| `totals.unenrolled` | `number` | Of those, `unenrolled`: neither retired nor suspended, with no credential and no host. Retired and suspended agents are in `identities` and in neither count. |
| `totals.holdingMandate` | `number` | Live agents in the workspace whose principal holds at least one active mandate. |
| `totals.mandateHolders` | `string[]` | The agent keys of the agents `holdingMandate` counts, in slug order, at most 100. |
| `totals.tamperIncidents` | `number` | Open incidents of a tamper kind (`hooks_removed`, `config_change`, `chain_break`, `checkpoint_lapse`, `token_replay`, `spoofed_event`), summed over the workspace's agents through the hosts enrolled under each agent key. An incident on a host no listed agent holds is not in it. |
| `totals.tamper` | `object` | `{ recorded, open, newest }`: every tamper incident the store keeps summed over the same agents, how many are open, and the newest as `{ agentKey, kind, detectedAt }` (null when there is none). The Agents page's Tamper incidents tile. |

## Roles

Org Owner, Admin, Member; workspace Owner, Member. The kernel's IAM check allows every capability for a non-enterprise org (ARCHITECTURE.md §1.5).

## Side effects

None. Read-only; audit-exempt.

## Surfaces

- `POST /api/v1/{org}/{ws}/agents`
- MCP tool `list_agents`

## Errors

| code | meaning |
|---|---|
| `authz_denied` | No authenticated principal, or no org or workspace scope. |
