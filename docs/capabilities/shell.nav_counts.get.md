# get_nav_counts

The sidebar's counts for a workspace (MC spec App. E): Fleet shows pending approvals, Steering shows open proposals, Audit shows open critical incidents. A count is null when its store does not exist, and a null renders as no badge.

Rev1 has approvals (`agent.approval_requests`); it has no proposals store until the #2961 lane lands and no incident store (Audit is cut to the archive at seal, `apps/app/ARCHITECTURE.md` §1.2), so `proposals` and `incidents` answer null.

## Mode

**sync**

## Surface

- API: `GET /v1/:org_slug/:workspace_slug/shell/nav-counts`
- MCP: `get_nav_counts`
- Authentication: session (org Owner, Admin or Member; workspace Owner, Member or Viewer)
- Capability name: `get_nav_counts`
- Not billed (`noBillingGate: true`): a console read is never a governed action (ADR-052 exclusion 2).

## Input

None.

## Output

| Field | Type | Description |
|---|---|---|
| `approvals` | integer or null | unresolved, unexpired approvals in this workspace — the predicate `list_approvals` pages on |
| `proposals` | null | no proposals store in rev1 |
| `incidents` | null | no incident store in rev1 |
