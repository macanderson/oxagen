---
# Policies

- **Route:** `/{orgSlug}/governance/policies`
- **Nav location:** org → Governance → tab "Policies"
- **Priority:** P3
- **Disposition vs today:** New

## Purpose
Policies contains non-IAM organization controls: per-capability entitlement/plan gates and MCP auth-alert settings. IAM roles, graph context permissions, tool permissions, principal assignments, and effective-access simulation move to `/{orgSlug}/governance/permissions` under the approved canonical design in `docs/specs/agent-rbac/spec.md`.

## Primary user & jobs-to-be-done
- **Primary user:** Org admin / security-conscious owner
- **JTBD:**
  - Understand which capabilities are gated behind which plan/entitlement tier.
  - Configure who receives MCP auth alerts and whether email notification is on.
  - Navigate to Permissions for IAM role and principal administration.
  - Navigate to related policy surfaces (org MFA policy, workspace budget policy) without hunting.

## Functionality
- **Entitlements table:** capability name, required plan/entitlement tier, current org tier, gate status (allowed/blocked).
- **MCP auth alerts panel:** toggle which roles receive alerts, email on/off switch.
- **Cross-link:** "Manage permissions" → Governance → Permissions.
- **Cross-links:** "Org MFA policy" → Security → MFA tab; "Workspace budget policies" → workspace settings (commercial terms are governed per-workspace, not per-org).

## Capabilities invoked
- `plugin.settings.set_auth_alerts` (`set_auth_alerts`) — configure MCP auth-alert recipients/email toggle.
- IAM role and permission contracts are specified separately in `docs/specs/agent-rbac/spec.md` and do not belong to this route.

## Data sources
Postgres (entitlement and MCP alert settings).

## States
- **Empty:** entitlements table is empty only if the org has no plan-gated capabilities; show "No entitlement gates configured."
- **Loading:** skeleton rows for entitlements and alert controls.
- **Error:** MCP auth-alert save failure shows an inline toast; entitlement read failure shows a page-level banner.

## Existing implementation
- **Today:** the page also renders a read-only roles section. Remove that section when Governance → Permissions ships; retain the entitlement and MCP alert controls here.

## Vision alignment
Keeps entitlement and notification controls visible without conflating commercial availability with IAM authority. The Permissions surface owns the permitted-action link of the accountability chain.
