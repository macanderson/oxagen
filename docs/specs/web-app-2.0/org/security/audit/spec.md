---
# Audit Log

- **Route:** `/{orgSlug}/security/audit`
- **Nav location:** org → Security → tab "Audit"
- **Priority:** P1
- **Disposition vs today:** Keep

## Purpose
The Audit Log is the immutable, queryable record of every governed invocation and security event in the org — the terminal link of the accountability chain. It exists so an admin, security manager, or auditor can answer "who did what, when, and was it allowed" without touching raw database tables, and so the org can export signed evidence for compliance.

## Primary user & jobs-to-be-done
- **Primary user:** Security manager / auditor
- **JTBD:**
  - Find every action a specific actor took in a time window.
  - Find every invocation of a specific capability and its outcome (allowed/denied).
  - Investigate a denied invocation to understand why it was blocked.
  - Export a signed, tamper-evident record for a compliance audit.

## Functionality
- **Filterable table:** columns — timestamp, actor, capability/event name, outcome (allowed/denied/error), resource, IP. Filters: actor, capability, outcome, date range. Keyset pagination (not offset) for large volumes.
- **Row detail:** expandable raw event payload.
- **Export action:** signed NDJSON or CSV export, gated to Enterprise plan + security-manager role, re-checked server-side at the export route (not just client-gated).

## Capabilities invoked
- `audit.log.query` (`query_audit_log`) — queries `security_events` and `playbook_events` with actor/capability/outcome filters.

## Data sources
Postgres (`security_events`, `playbook_events`), via `audit.log.query`.

## States
- **Empty:** "No audit events match your filters" when filtered to zero; org with zero history is not realistic (audit starts at signup) so no true first-run empty state.
- **Loading:** skeleton rows while the keyset page loads; export shows a progress indicator while the signed file is generated.
- **Error:** query failure shows inline banner with retry; export failure (e.g. plan/role check fails server-side) shows a clear "not permitted" message distinct from a transient error.

## Existing implementation
- **Today:** COMPLETE — filterable, keyset-paginated audit-log viewer with signed NDJSON/CSV export gated Enterprise + security-manager, re-checked at the export route. Reuse as-is.
- **Note:** `query_audit_log` is invoked from the app but its contract omits `app` from `layers[]` — a reverse-parity gap. Recommend declaring `app` on the `audit.log.query` contract so `check:ui-parity` stops flagging it.

## Vision alignment
The audit-record link — the immutable end of the accountability chain that every invocation leaves behind. P1 because it is the concrete proof of the governance wedge and the primary SOC 2 evidence surface.
