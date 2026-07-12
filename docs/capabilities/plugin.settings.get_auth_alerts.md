# plugin.settings.get_auth_alerts

Read the org's MCP auth-alert notification setting — which org roles receive alerts and whether email is sent in addition to in-app notification. Returns the documented default (`{ sendEmail: true, roles: ["Owner", "Admin"] }` with `isDefault: true`) when the org has never customised the setting. Read counterpart of [plugin.settings.set_auth_alerts](plugin.settings.set_auth_alerts.md); powers the org Governance → Policies alerts panel.

## Mode
**sync**

## Surfaces
- API: `GET /v1/plugin/settings/auth-alerts`
- MCP: `get_auth_alerts`
- Agent: callable (no approval required, risk: low)
- App: org → Governance → Policies

## Access
Admin-level. Default roles: org `Owner`/`Admin`. Sensitivity: **low**. `noBillingGate`.

## Input
None.

## Output
| Field | Type | Description |
|-------|------|-------------|
| `sendEmail` | boolean | Whether email is sent in addition to in-app notification |
| `roles` | (`"Owner" \| "Admin" \| "Compliance" \| "Billing"`)[] | Org roles that receive MCP auth alerts |
| `isDefault` | boolean | True when the org has never customised the setting |
