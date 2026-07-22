---
# Governance Hub

- **Route:** `/{orgSlug}/governance`
- **Nav location:** org → Governance (group landing page)
- **Priority:** P1
- **Disposition vs today:** New (flagship vision surface — nothing today unifies the accountability chain)

## Purpose
The Governance hub is the single screen that makes Oxagen's core differentiator legible: every capability invocation is one enforced object binding identity → knowledge scope → permitted action → commercial terms → verified outcome → audit record. Today those six links are scattered across members, security, billing, and audit pages with no page that shows them as one chain. This hub is the landing page for the Governance nav group, giving an org admin an at-a-glance board of chain health and deep links into each link's dedicated surface.

## Primary user & jobs-to-be-done
- **Primary user:** Org admin / compliance-minded owner
- **JTBD:**
  - See the health of each link in the accountability chain in one glance.
  - Spot recent denied invocations (permitted-action failures) without digging through raw audit logs.
  - Understand how many contracts are active and how much invocation volume they carry.
  - Jump directly into the deeper surface for whichever link needs attention (capabilities, access, billing, audit).

## Functionality
- Six-card board, one per accountability-chain link, each linking deeper:
  - **Identity** — member/role counts, link to People.
  - **Knowledge scope** — graph grounding coverage summary, link to knowledge surfaces.
  - **Permitted action** — capability catalog size + entitlement gates, link to Governance → Capabilities.
  - **Commercial terms** — metering/billing snapshot, link to Billing & Revenue → Usage.
  - **Verified outcome** — eval/feature-verify pass rate, link to relevant eval surface.
  - **Audit record** — recent audit-event volume, link to Security → Audit.
- "Recent denied invocations" table: actor, capability, reason, timestamp (from audit log filtered to denied outcomes).
- Summary tiles: active contracts count, total audit events (period), denied-invocation rate.
- Cross-links to Capabilities catalog, Access, Security/Audit, Billing/Usage.

## Capabilities invoked
- `audit.log.query` (`query_audit_log`) — denied-invocation feed and audit-event totals.
- Reads capability counts from the manifest (`pnpm check:manifest` data source, not yet a runtime contract).
- **Contract gap:** no read contract exposes the live typed-contract registry to the app at runtime — author `capability.registry.list` (contract → API → MCP → UI) to drive the "active contracts" tile and the Capabilities catalog page.

## Data sources
Postgres (`security_events`, `playbook_events` via `audit.log.query`) + capability manifest (build-time today; needs a runtime contract).

## States
- **Empty:** no denied invocations in period → "No denied invocations — all clear" state on that card.
- **Loading:** skeleton cards while audit query + manifest counts resolve.
- **Error:** card-level fallback ("Unable to load") per section; other cards remain interactive.

## Existing implementation
- **Today:** no equivalent page exists. Build new; compose from existing `audit.log.query` usage patterns already proven in `security/page.tsx` and `security/audit`.

## Vision alignment
This is the "one enforced object" made visible — the accountability chain nobody else bundles, surfaced as a single page. P1 because it is the flagship expression of the governance wedge, not incidental UI.
