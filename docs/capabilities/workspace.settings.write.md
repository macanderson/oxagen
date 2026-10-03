# update_workspace_settings

**Domain:** workspace
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Update a workspace's general settings — name, slug, description, and avatar —
as a **partial** update: omit a field to leave it unchanged, pass a value to
set it, pass `null` (description and avatarUrl only) to clear it. The target
is the active workspace, or the one `workspaceId` names in the organization
(the Organization › Workspaces section edits from an org scope). Routes the
workspace settings edit through the capability kernel so the same fields are
reachable from the agent, MCP, and CLI with consistent audit. It also carries
the workspace's consequence-role overrides for mandates.

The handler checks roles (`assertOrgRole`, INV-29). Org Owners and Admins edit
any workspace of the organization. The Owner or Admin of the workspace the call
is scoped to edits that workspace only: a call that sets `workspaceId` requires
an org Owner or Admin and is refused with `forbidden` / `org_role_required`
otherwise. `consequenceRoles` is the org Owner's alone, because the map decides
who may grant a mandate over money and the other consequences (ADR-059
decision 1); any other acting user is refused with `forbidden` /
`org_role_required` and nothing is written. `noBillingGate`:
a settings write, never a governed action (ADR-052 exclusion 2).

## Input

| Field       | Type                                 | Notes                                                                                                               |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| workspaceId | string (`wrk_…`), optional           | The workspace to update; omitted, the workspace the call is scoped to                                               |
| name        | string (1–120, trimmed), optional    | New display name                                                                                                    |
| slug        | string (1–100, kebab-case), optional | New URL slug; must be unique within the org                                                                         |
| description | string (≤2000) \| null, optional     | Free-text description; `null` clears it                                                                             |
| avatarUrl   | string \| null, optional             | `https://` URL or an `avatar:v1:<json>` designed-avatar spec; `null` clears the avatar (mirrors org.settings.write) |
| consequenceRoles | Record<tag, OrgRole[]>, optional | The consequence-role overrides for mandates (ADR-059 decision 1); replaces the stored overrides as a whole, a tag left out falls back to the default; org Owner only |

## Output

| Field       | Type           | Notes                                      |
| ----------- | -------------- | ------------------------------------------ |
| name        | string         | Workspace display name after the update    |
| slug        | string         | URL slug after the update                  |
| description | string \| null | Description after the update               |
| avatarUrl   | string \| null | Avatar after the update; `null` when unset |
| consequenceRoles | Record<tag, OrgRole[]> | The effective map after the update, as `get_workspace_settings` returns it |

## Side effects

Persists the changed fields to Postgres (workspace row + settings bag).
ClickHouse observes the invocation via the kernel; the change is audit-logged.

## Errors

| code            | reason                               | when                                                                                                                                          |
| --------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `forbidden`     | `no_principal` / `org_role_required` | no signed-in user and no API key with a live creator, or an acting user (the signed-in user, or the key's creator) outside the accepted roles; `org_role_required` also when `consequenceRoles` comes from an acting user who is not an org Owner |
| `not_found`     | `workspace_not_found`                | no workspace with that public id in the org, or the active one is not in the org                                                              |
| `conflict`      | `slug_taken`                         | the slug is already used by another workspace in the org                                                                                      |
| `invalid_input` | —                                    | the slug fails the contract's validator (kernel)                                                                                              |

`runEnrichmentEnabled` is an optional boolean. It defaults to true for existing workspaces. False stops automatic Stella generation of run names and summaries and displays run IDs. It does not change recording or deterministic evidence. The same workspace settings role gate applies. The write merges this key into the settings bag without replacing steering settings. Setting it back to true writes the workspace row alone. The five-minute sweep then summarizes each run that has no account, changed after its last one, or failed, a few per organization at a time. A run whose account is current is not summarized again.

`dailyBudgetUsd` is an optional patch of the workspace's daily limits on its own model calls, in US dollars per UTC day: `runEnrichment` (run names and summaries), `assistant` (Stella chat in the app), and `work` (triage and work orders). A lane left out keeps its value; null removes a lane's limit; zero switches the lane off. A value is zero or more and at most 100,000. The write merges the patch into the stored block, so two people editing two lanes do not overwrite each other. The gates read the limit before each call: the enrichment job refuses a pass once the day's run-enrichment spend reaches the limit and records `workspace_budget_spent` on the run; an assistant turn or a conversation title is refused with the 402 code `workspace_budget_spent`; triage records the refusal on the work item. The limit applies whoever pays the vendor, the platform key or the organization's own. Each resets at 00:00 UTC. A burst of concurrent calls can take a lane a few calls past its limit, because the counter is added to after each call settles.
