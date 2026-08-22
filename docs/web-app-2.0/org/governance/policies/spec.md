---
# Policies

- **Route:** `/{orgSlug}/governance/policies`
- **Nav location:** org → Governance → tab "Policies"
- **Priority:** P3
- **Disposition vs today:** New

## Purpose
Policies is where an org admin views and edits the rules that decide who is permitted to do what: IAM roles and their permission grants, per-capability entitlement/plan gates, and MCP auth-alert settings. It is the human-editable face of the "permitted action" and "entitlement" links of the accountability chain, currently only configurable via seed scripts.

## Primary user & jobs-to-be-done
- **Primary user:** Org admin / security-conscious owner
- **JTBD:**
  - See which IAM roles exist and what permissions each grants.
  - Understand which capabilities are gated behind which plan/entitlement tier.
  - Configure who receives MCP auth alerts and whether email notification is on.
  - Navigate to related policy surfaces (org MFA policy, workspace budget policy) without hunting.

## Functionality
- **Roles & permissions table:** role name, description, permission list (grouped by domain), member count using the role. Edit affordance per role (add/remove permission) — gated by contract once it exists.
- **Entitlements table:** capability name, required plan/entitlement tier, current org tier, gate status (allowed/blocked).
- **MCP auth alerts panel:** toggle which roles receive alerts, email on/off switch.
- **Cross-links:** "Org MFA policy" → Security → MFA tab; "Workspace budget policies" → workspace settings (commercial terms are governed per-workspace, not per-org).

## Capabilities invoked
- `plugin.settings.set_auth_alerts` (`set_auth_alerts`) — configure MCP auth-alert recipients/email toggle.
- **Contract gap:** there is no app-facing contract to read or write IAM roles, permission grants, or entitlement gates today — these are seeded via `db:seed-iam` / `db:backfill-iam` scripts only. Author read/write contracts for IAM role and entitlement management (contract → API → MCP → UI is law) before wiring the roles/entitlements tables to live editable data; until then, render them read-only from a direct query if one exists, or stub with an explicit "not yet editable" note.

## Data sources
Postgres (IAM role/permission tables, entitlement tables).

## States
- **Empty:** roles table never empty (default roles always seeded); entitlements table empty only if org has no plan-gated capabilities (rare, show "No entitlement gates configured").
- **Loading:** skeleton rows for roles and entitlements tables.
- **Error:** MCP auth-alert save failure shows inline toast; roles/entitlements read failure shows page-level banner since the contract gap means this may be read-only for a while.

## Existing implementation
- **Today:** no equivalent page exists; IAM is seeded and backfilled via repo scripts only, with no app-facing surface.

## Vision alignment
Makes the permitted-action and entitlement links of the accountability chain human-editable instead of script-only. P3 because it needs new contracts before it can be more than a read-only view.
