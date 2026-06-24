# Preview-Page Build Specs

For every page that ships a "Preview · not yet wired to live data" banner in production, this maps the page to the **already-shipped contracts** (verified against `packages/oxagen/src/contracts/`, `apps/api/src/routes/v1/`, `apps/mcp/src/tools/`), gives a concrete build spec, and flags the small set that shouldn't be built natively.

**Wiring order is always:** contract (`packages/oxagen/src/contracts/`) → API route (`apps/api/src/routes/v1/`) → MCP tool (`apps/mcp/src/tools/`) → UI wire-up (replace mock with the contract via `invoke()`), per CLAUDE.md capability-parity law. Pages whose backend is **already wired** skip straight to the UI step.

Priority key: **P1** = backend already exists, pure UI wire-up, high user value (do first). **P2** = needs one new list/CRUD contract. **P3** = enterprise/heavy or integrate-don't-build.

---

## Tier 1 — backend already shipped, just wire the UI (highest ROI)

### 1. `/{ws}/activity/audit` — **P1, trivial**
- **Backend:** `audit.log.query` is fully wired (API + MCP). Page even says "Workspace-scoped slice of the org-wide audit log. Every capability invocation…".
- **Spec:** Replace mock rows with `invoke("audit.log.query", { workspaceId, cursor, filters })`. Columns: timestamp, actor (principal), capability, resource, outcome, latency. Add filter chips (actor, capability namespace, date range) and cursor pagination. Server-resolve actor → human label (don't render raw principal IDs — see CLAUDE.md citation rule). Reuse the same query for `/{org}/security/audit` (the Enterprise-gated export is a superset).
- **Effort:** XS (1 contract already exists; UI + pagination only).

### 2. `/{ws}/activity/approvals` — **P1**
- **Backend:** `agent.approval.resolve`, `agent.plan.approve`, `agent.plan.create` are wired. The mock shows real-looking pending approvals (GitHub sync, Stripe list-invoices).
- **Gap:** no `agent.approval.list` contract — there's a resolve but no list. Add **one** contract `agent.approval.list` (workspace-scoped, status filter) → route → tool.
- **Spec:** List pending/resolved approvals via the new list contract; Approve/Reject buttons call `agent.approval.resolve({ approvalId, decision, reason })`. Show requesting agent (human label), requested capability, payload diff, requested-at, and the human who resolved. Optimistic update + toast. This is the human-in-the-loop gate for agent plans — high trust value.
- **Effort:** S (1 new list contract + UI).

### 3. `/{ws}/automation/triggers` — **P1**
- **Backend:** `agent.trigger.create / list / update / delete` all wired (API + MCP). Mock already shows realistic schedule + event triggers.
- **Spec:** Wire the list to `agent.trigger.list`; "New trigger" opens a drawer (schedule cron vs. event-type selector) → `agent.trigger.create`; row actions pause/resume → `agent.trigger.update({ enabled })`, delete → `agent.trigger.delete`. Show fire count + last-fired from trigger records.
- **Effort:** S (pure wire-up).

### 4. `/{ws}/automation/playbooks` — **P1**
- **Backend:** `automation.create / list / update / enable / disable / trigger` wired. Footer literally says "Playbooks are available via the API and MCP surfaces today. In-app playbook builder coming soon."
- **Spec (two phases):**
  - *Phase 1 (S):* List real automations via `automation.list`; enable/disable toggles; "Run now" → `automation.trigger`; version + run-count from records. Drops the preview banner immediately.
  - *Phase 2 (M):* In-app builder — a step composer (trigger → conditions → capability steps → approval gate) writing to `automation.create/update`. Reuse the trigger selector from #3.
- **Effort:** S then M.

### 5. `/{ws}/studio/compose` — **P1, high value**
- **Backend:** Fully shipped — `agent.compose`, `image.generate`, `image.create`, `document.create`, `documents.generate`, `documents.pdf.create`, `video.generate`, `svg.generate`, `mermaid.generate`, `markdown.generate`. This is one of the most-wired namespaces in the product.
- **Spec:** "Select a kind, choose a brand kit, generate." Kind selector → routes to the matching generate contract (text→`markdown.generate`/`document.create`, image→`image.generate`, diagram→`mermaid.generate`/`svg.generate`, video→`video.generate`, pdf→`documents.pdf.create`). Brand-kit selector applies `brandkit.apply` post-generate. Stream/poll result, render preview, "Save to Library" persists the asset. Credit-cost preview before submit (this consumes credits — show estimate).
- **Effort:** M (orchestration UI over many existing contracts). **Biggest single ROI** — backend is done, content generation is a headline feature sitting behind a preview banner.

### 6. `/{ws}/knowledge/memories` — **P1**
- **Backend:** `agent.memory.recall` + `agent.memory.write` wired. Page: "Workspace-scoped rules, facts, preferences, and agent-proposed lessons."
- **Gap:** needs `agent.memory.list` (paged, by type/scope) — recall is semantic search, not enumeration. Add one list contract.
- **Spec:** List memories grouped by type (rule / fact / preference / agent-proposed lesson) with confidence + source. Inline create → `agent.memory.write`; approve/reject agent-proposed lessons (reuse the approvals pattern). Search box → `agent.memory.recall`. High value: this is how users steer agent behavior.
- **Effort:** S (1 list contract + UI).

---

## Tier 2 — needs one new CRUD/list contract

### 7. `/{ws}/studio/library` — **P2**
- **Backend:** `document.list`, `image.list` exist but there's no unified asset list. Add `asset.list` (or `studio.library.list`) that unions documents/images/videos/svg by workspace with kind+brandkit+date filters. `asset.upload` already exists for the storage side.
- **Spec:** Gallery/table of saved generations; filter by brand kit, kind, date; row actions: open, export (`documents.pdf.create` for docs), re-run (re-invoke the original generate contract with stored params), delete. Pairs with Compose (#5) — Compose writes here.
- **Effort:** M (1 union contract + gallery UI).

### 8. `/{ws}/settings/brand-kits` — **P2**
- **Backend:** `brandkit.apply` is wired (consumer side) but there's no brand-kit CRUD. Add `brandkit.create / list / get / update / delete` (Postgres-backed: name, palette, typography, logo refs in blob storage, voice/tone).
- **Spec:** List brand kits; create/edit form (colors, fonts, logo upload via `asset.upload`, tone guidelines); set default. Consumed by Studio Compose/Library (#5, #7).
- **Effort:** M.

### 9. `/{ws}/settings/model-keys` — **P2**
- **Backend:** `workspace.model.settings.read/write` exist (model selection) but **BYOK secret storage** is the missing piece. The secure secret pattern already exists for plugins (`plugin.credential.set_secret`). Add `model.key.set / list / delete` reusing that encrypted-secret mechanism (store provider + encrypted key, never return the secret).
- **Spec:** Per-provider (OpenAI, Anthropic, Google, …) "Bring your own key" rows; add key → `model.key.set` (write-only, masked on read); test-connection button; delete. When a workspace key exists, route LLM calls through it (must still go through `@oxagen/ai` for metering — see CLAUDE.md). Show which models each key unlocks.
- **Effort:** M (secret storage reuse + provider routing).
- **Note:** Security-sensitive (secrets) → Opus-tier change per operating model.

### 10. `/{ws}/automation/event-sources` — **P2**
- **Backend:** Events are referenced by `agent.trigger.*` (event-type triggers) and `automation.*`, but there's no first-class event-source registry contract. The mock shows `knowledge.source.created`, `agent.run.failed`, `billing.credit.low`.
- **Decision:** These event types are **emitted by the platform**, not user-defined — so a full CRUD "create event source" is questionable. **Recommended scope:** make this a **read-only catalog** of subscribable platform event types (enumerate from the event registry) with per-event fire-history (from ClickHouse telemetry) and a "create trigger from this event" shortcut into #3. A new `event.catalog.list` (read-only) contract backs it.
- **Effort:** S (read-only catalog) — and drop the "New event" button, which implies user-authored events that don't exist.

---

## Tier 3 — enterprise features (real, heavier) and don't-build-natively

### 11. `/{org}/security/sso` — **P2/Enterprise, worth building**
- **Backend:** Better Auth ships an **SSO plugin** (SAML 2.0 / OIDC) — see `vendor-better-auth` skill. Not yet surfaced as Oxagen contracts.
- **Spec:** Add `org.sso.config.read/write` (provider type, metadata URL/XML, ACS, attribute mapping, enforce-for-domain). UI: configure IdP, upload metadata, test connection, enforce. Real enterprise unlock — pairs with MFA enforcement (already live at `/security/mfa`).
- **Effort:** L. High enterprise-revenue value. Opus-tier (auth).

### 12. `/{org}/security/scim` — **P2/Enterprise**
- **Backend:** Better Auth supports SCIM-style provisioning; needs an Oxagen `org.scim.*` surface (token issue/rotate, provisioning endpoint, group→role mapping).
- **Spec:** Generate a SCIM bearer token, expose the SCIM 2.0 base URL, map IdP groups to Oxagen roles, show last-sync + provisioned-user count. Depends on the IAM/roles model — which currently has **no contracts** (see Access section below), so SCIM should follow IAM being built.
- **Effort:** L. Sequence **after** the Access/IAM section exists.

### 13. `/{org}/security/incidents` — **don't build natively (comment)**
- **Backend:** none. Mock shows fake "Open/Investigating 1, Critical 1, Closed 2".
- **Recommendation:** **A native security-incident tracker doesn't make sense to build.** Customers who need incident management already run PagerDuty/Opsgenie/Jira. Building a parallel ticketing system is scope creep with low differentiation. **Repurpose this route** into a **"Security signals"** page that surfaces *Oxagen-native* security events from `audit.log.query` (failed-auth bursts, anomalous capability use, MFA-disabled members, expiring API keys) with a "forward to your incident tool via webhook" action (depends on #14). That's defensible and uses data only Oxagen has.

### 14. `/{org}/developer/webhooks` — **P2**
- **Backend:** `github-webhook` (inbound) and a `webhook` route exist, but no **outbound subscription** contract. Add `webhook.endpoint.create/list/delete` + `webhook.delivery.list` (Postgres for config, ClickHouse for delivery log) and an internal dispatcher that fans platform events (the same catalog as #10) to subscriber HTTPS endpoints with HMAC signing + retries.
- **Spec:** Register endpoint URL, select event types, view signing secret, delivery log with replay. Unblocks #13's "forward to incident tool". Page already lists planned event types.
- **Effort:** M–L (dispatcher + retries).

### 15. `/{org}/developer/docs` — **trivial, not really a "feature"**
- **Backend:** none needed — it's a docs hub. The "Preview · not yet wired" banner is misleading; the content (Quickstart, REST API reference, MCP server) is just static links.
- **Recommendation:** **Drop the preview banner**, point the cards at `https://docs.oxagen.sh` (and the live OpenAPI spec / `https://mcp.oxagen.sh`), and embed a copyable MCP snippet (reuse the working component from `/developer/mcp`). 30-minute change; remove the false "preview" signal.
- **Effort:** XS.

---

## Cross-cutting: the Access / IAM section (bug #2) needs a spec too

`/{org}/access/{sessions,policies,roles,grants,reviews,principals,requests}` all redirect to `/ask` and have **zero backing contracts** — the whole IAM surface is unbuilt despite RBAC being a homepage promise ("RBAC-enforced retrieval", "SOC 2 Type II · SSO/SCIM"). This is the **largest coherent gap** and gates SCIM (#12).

- **Build order:** `principals` (users/service-accounts/agents) → `roles` (role + permission sets, `db:seed-iam` already exists) → `grants` (principal×role×scope) → `policies` (conditions) → `requests` + `reviews` (access-request workflow, reuses the approvals pattern from #2) → `sessions` (active session list + revoke, Better Auth-backed).
- New contract namespace `iam.*` (e.g. `iam.principal.list`, `iam.role.list/upsert`, `iam.grant.create/revoke`, `iam.request.create/resolve`, `iam.session.list/revoke`).
- **Until built, the nav links must not silently redirect** — either hide them or show an explicit "Coming soon" state (the silent redirect to `/ask` reads as a bug).
- **Effort:** L–XL (epic). High value: it's table-stakes for the enterprise/SOC 2 positioning the marketing copy sells.

---

## Missing-feature suggestions & live-page repurposes

1. **`knowledge/nodes` is a 404 (bug #1)** but the nav implies a node browser. **Build it:** a searchable, filterable node list backed by `graph.node.list` + `graph.node.search` (both wired), each row linking to the existing `knowledge/nodes/[nodeId]` detail. Cite nodes by human label, not UUID (CLAUDE.md). This is pure wire-up over shipped contracts — quick win that also fixes the 404.

2. **Studio is the sleeping giant.** Compose + Library (#5, #7) have nearly the entire generation backend shipped but sit behind preview banners. Prioritize — it's the most under-exposed shipped capability.

3. **Unified "Approvals" inbox.** Approvals (#2), agent-proposed memories (#6), and access-requests (IAM) all share the same approve/reject-with-reason pattern. Build one reusable approval component + a single notification badge (`notifications.list` is wired) so users have one place to action everything.

4. **Repurpose `developer/tokens`** (bug #5): add the missing "Create token" UI (`api.key.create` is wired — API + MCP) with scope selection, one-time reveal, and rotate (`api.key.rotate`) / revoke (`api.key.revoke`, both wired). The backend is 100% done; only the create/rotate UI is missing, and `/developer/mcp` already depends on it.

5. **Billing usage → cost insights.** `billing/usage` is live and good. Enhance with per-capability and per-agent cost breakdown (data exists in ClickHouse `token_usage`) and a projected end-of-period spend — turns a usage meter into a cost-control tool, directly relevant to the "$4.59 remaining / low on credits" warning users see.

6. **Drop or gate every false "Preview" banner once wired**, and convert genuine plan-gates (`security/audit`, `security/compliance`) to a consistent "Enterprise" upsell component rather than the same "Preview" styling — users currently can't tell "not built yet" from "not on your plan."
