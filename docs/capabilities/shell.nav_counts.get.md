# get_nav_counts

The sidebar's counts for a workspace (MC spec App. E): Fleet shows pending approvals and open questions, Steering shows open proposals, and Audit shows open critical incidents. The handler reads approvals, questions, and proposals for the workspace in one tenant-scoped transaction, and incidents for the organization through the org-wide seam (ADR-086). A count is null only when its read answered no row, and the app renders a null as "not recorded", never as a zero.

## Mode

**sync**

## Surface

**Surfaces:** api, mcp, agent

- API: `GET /v1/:org_slug/:workspace_slug/shell/nav-counts`
- MCP: `get_nav_counts`
- Agent: the in-app assistant finds it with `search_tools` and loads it with `load_tools`. Low risk, no approval.
- Authentication: session (org Owner, Admin or Member; workspace Owner, Member or Viewer)
- Capability name: `get_nav_counts`
- Not billed (`noBillingGate: true`): a console read is never a governed action (ADR-052 exclusion 2).

## Input

None.

## Output

| Field | Type | Description |
|---|---|---|
| `approvals` | integer or null | unresolved, unexpired approvals in this workspace — the predicate `list_approvals` pages on |
| `interjections` | integer or null | unanswered, unexpired questions agents in this workspace paused to ask, in `agent.interjections`: the predicate `list_interjections` pages on with `open: true` (#3839) |
| `proposals` | integer or null | steering proposals in `agent.context_proposals` that have not merged and were not rejected, the rows `list_proposals` returns |
| `incidents` | integer or null | unresolved incidents at severity 10 in `tacho.incidents` across the organization (Audit is an organization page), read through the org-wide seam |
