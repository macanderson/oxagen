---
# Capability & Contract Catalog

- **Route:** `/{orgSlug}/governance/capabilities`
- **Nav location:** org → Governance → tab "Capabilities"
- **Priority:** P1
- **Disposition vs today:** New

## Purpose
This page is the org-wide governed contract registry — a searchable, inspectable catalog of every typed capability contract in the system, showing exactly how each one binds identity, knowledge scope, permitted action, commercial terms, verified outcome, and audit record. It is distinct from the workspace-level installed capability packs (`workbench/tools/capabilities`, which manages plugin installs); this page is about the contracts themselves, org-wide, regardless of which workspaces have them installed.

## Primary user & jobs-to-be-done
- **Primary user:** Org admin / platform engineer
- **JTBD:**
  - Find a capability by name or domain and understand what it does and who can call it.
  - Check which surfaces (api/mcp/app) a capability is wired to, and spot surface gaps.
  - See what a capability costs to invoke (meter/price) and how much usage it's seeing.
  - Audit who has actually called a sensitive capability recently.

## Functionality
- **Catalog table:** columns — capability name (dotted), domain, layers (api/mcp/app badges), IAM role/entitlement required, metered price/meter name, docs link. Search box (name/domain) and filters: by domain, by surface-gap (any layer missing).
- **Row detail (drawer/panel):** full accountability binding for the selected capability — identity (roles allowed to call it), knowledge scope (data it can touch), permitted action (what it does), commercial terms (the meter it emits), verified-outcome expectations (eval coverage, if any), audit event name it logs.
- **Per-capability usage tab:** ClickHouse-backed call volume/cost over selectable period.
- **Recent audit events tab:** last N audit events for this specific capability (actor, outcome, timestamp).

## Capabilities invoked
- `billing.usage.breakdown` (`get_usage_breakdown`) — per-capability metering slice.
- `audit.log.query` (`query_audit_log`) — per-capability audit events.
- **Contract gap:** the contract registry itself is introspected today only via a repo script (`pnpm check:manifest`) — author `capability.registry.list` / `capability.registry.get` read contracts (contract → API → MCP → UI is law) before this table can be wired to live data.

## Data sources
Postgres (contract registry, once the contract exists) + ClickHouse (`billing.usage.breakdown`) + Postgres (`audit.log.query`).

## States
- **Empty:** should never be empty (contracts always exist); filtered-to-zero shows "No capabilities match your filters."
- **Loading:** skeleton table rows; row-detail panel shows skeleton while usage/audit sub-tabs resolve.
- **Error:** registry-read failure shows a full-page error (this page is unusable without it); usage/audit sub-tab failures degrade to "unavailable" within the drawer only.

## Existing implementation
- **Today:** no equivalent page exists. `pnpm check:manifest --json` is the only current introspection path, and it is a repo script.

## Vision alignment
This page is the governance wedge, literally — the typed contract as the un-poisonable, metered, IAM-gated object made inspectable by a human. P1 because it is the concrete artifact the wedge is named after.
