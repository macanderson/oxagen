# Oxagen App — Production UI Audit

**Target:** https://app.oxagen.sh
**Date:** 2026-06-24
**Account:** `macanderson.usa@gmail.com` · org `thomas-anderson-mac` · workspace `default` (Build plan, $4.59 credits)
**Method:** `playwright-cli` (bundled chromium, authenticated session reused across crawlers). 57 in-app routes crawled by 5 parallel haiku subagents; **all billing/developer/account/security/access routes independently re-verified by hand** (see Methodology note).
**Screenshots:** `./screenshots/*.png` (53 files)

---

## Methodology note / data-quality caveat

Two of the five crawler agents hit a **shared-config race**: a subagent overwrote the shared `pw.config.json` mid-run, so later agents' browsers failed to launch and silently fell back to a missing Chrome channel. The affected agents (Group D tail, Group E) then **reported guessed results** — most damagingly, a fabricated "every billing/developer/account route redirects to Security" finding.

**Every one of those routes was re-navigated by hand and confirmed false.** All billing, developer, members, and account pages load correctly with live data. The findings below reflect the hand-verified truth, not the raw crawler output. Lesson for future runs: give each parallel browser agent its **own** config file.

---

## Bugs (verified)

| # | Severity | Page | Bug | Evidence |
|---|----------|------|-----|----------|
| 1 | **P1** | `/{ws}/knowledge/nodes` | Hard **404 "Page not found"**. The Knowledge → Nodes route renders the app 404 page. A `[nodeId]` detail route exists but the index list route is dead. | innerText = "404 Page not found The page you're looking for doesn't exist or has moved." |
| 2 | **P2** | `/{org}/access/*` (all 7: sessions, policies, roles, grants, reviews, principals, requests) | Entire **Access / IAM section silently redirects to `/{ws}/ask`**. Pages are unreachable — the nav entries (if any) are dead. Not a permission gate (account is org **owner**); routes just aren't wired. | `location.pathname` after each nav = `/thomas-anderson-mac/default/ask` |
| 3 | **P3** | `/{ws}/knowledge/graph` | Empty-graph state shows **"Last updated 1/1/1970, 12:00:00 AM"** — a null/zero timestamp rendered as Unix epoch instead of "never" / "—". | innerText: "NODES 0 EDGES 0 INFERRED 0 SOURCES 0 Last updated 1/1/1970, 12:00:00 AM" |
| 4 | **P3** | Global (ask, security/*, account/*, access/*) | **React minified error #418** (hydration text mismatch) in console on many pages. Non-blocking but indicates an SSR/CSR text mismatch worth fixing. | Console: "Minified React error #418" |
| 5 | **P3 / UX** | `/{org}/developer/tokens` | Page works but there is **no "Create token" button** — copy says "Tokens can be created via the Oxagen API." MCP setup (`/developer/mcp`) explicitly tells users to create a token on this tab, so the two pages contradict each other. Dead-end for non-API users. | "No API tokens yet. Tokens can be created via the Oxagen API." |

### Not bugs (intentional, noted for completeness)
- `/{ws}/chat` → redirects to `/{ws}/ask` (intentional alias).
- `/{org}/settings/billing` → `/{org}/billing/subscription`; `/{org}/settings/members` → `/{org}/members` (intentional consolidation aliases).
- `/{org}/security/audit` & `/security/compliance` show "Enterprise feature" gates — that's a **plan gate**, not a mock (the account is on Build, not Enterprise).

---

## Preview / static-mock pages ("not yet wired to live data")

15 pages ship a visible **"Preview · not yet wired to live data"** (or "coming soon") banner in production. Full build specs for each are in **`PREVIEW-PAGE-SPECS.md`**.

| Page | Banner text | Backend ready? |
|------|-------------|----------------|
| `/{ws}/activity/approvals` | "Preview · not yet wired to live data" | **Yes** — `agent.approval.resolve`, `agent.plan.approve` wired |
| `/{ws}/activity/audit` | "Preview · not yet wired to live data" | **Yes** — `audit.log.query` wired |
| `/{ws}/automation/playbooks` | "Preview · not yet wired to live data" (footer: "available via API and MCP today") | **Yes** — `automation.*` wired |
| `/{ws}/automation/triggers` | "Preview · not yet wired to live data" | **Yes** — `agent.trigger.*` wired |
| `/{ws}/automation/event-sources` | "Preview · not yet wired to live data" | Partial — covered by `automation.*` / `agent.trigger.*` |
| `/{ws}/knowledge/memories` | "Preview · not yet wired to live data" | **Yes** — `agent.memory.recall/write` wired (needs a list endpoint) |
| `/{ws}/studio/compose` | "Preview · not yet wired to live data" | **Yes** — `agent.compose`, `image/document/video/svg/mermaid/markdown.generate` all wired |
| `/{ws}/studio/library` | "Preview · not yet wired to live data" | Partial — `document.list`, `image.list` wired (needs unified asset list) |
| `/{ws}/settings/model-keys` | "Preview · not yet wired to live data" | Partial — needs a BYOK model-key contract |
| `/{ws}/settings/brand-kits` | "Preview · not yet wired to live data" | Partial — `brandkit.apply` wired (needs CRUD) |
| `/{org}/security/incidents` | "PREVIEW · NOT YET WIRED TO LIVE DATA" (fake counts) | **No** — no incident contract |
| `/{org}/security/sso` | preview (SAML/OIDC config not wired) | **No** — Better Auth SSO plugin not surfaced |
| `/{org}/security/scim` | preview (SCIM 2.0 not wired) | **No** — Better Auth SCIM not surfaced |
| `/{org}/developer/docs` | "Preview · not yet wired to live data" | N/A — static docs hub |
| `/{org}/developer/webhooks` | "Webhooks coming soon … in development" | **No** — generic webhook subscription contract missing |

---

## Live, working pages (verified)

**Workspace:** `ask` (chat streams real agent runs), `explore`, `knowledge/graph` (live, empty), `knowledge/sources`, `automation/agents` (live empty state), `activity/runs` (real fan-out run visible).
**Workspace settings:** `general`, `knowledge` (Schema Registry), `integrations`, `plugins`, `skills`, `models`, `prompts`, `members`.
**Org:** `settings/general`, `settings/privacy` (GDPR export/erase), `billing/usage` ($0.08 spent / 6,906 tokens, real charts), `billing/invoices` (real invoice $20.00 paid), `billing/subscription` (Build plan, credit ledger), `members` (1/1 license), `developer/mcp` (live MCP connect instructions), `developer/tokens` (live, but see bug #5).
**Account:** `profile` (connected accounts: Google ✓, GitHub ✗), `preferences` (font/density/submit-behavior), `security` (MFA status, sign-in methods), `privacy` (GDPR).
**Security:** `mfa` (org enforcement toggle, SOC 2 CC6.1), `trust` (security docs), `audit`/`compliance` (Enterprise-gated, real).

---

## Form testing summary

Per production-safety protocol, mutating/outward submits (invites, billing changes, key creation, deletions, SSO/SCIM config, security changes) were **filled + screenshotted but not submitted**. Non-destructive probes performed:
- **Ask chat** (`/ask`): submitted "What data sources are connected to this workspace?" → streamed a real agent response with run tracking. ✅ Works end-to-end.
- Validation states across settings forms captured; no client-side validation bugs observed on the pages reached.
- No production data was mutated. No settings were changed.
