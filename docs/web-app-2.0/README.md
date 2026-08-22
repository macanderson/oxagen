# Oxagen Web App 2.0 — Information Architecture

This directory is the **recommended information architecture** for `apps/app`. It is a
design document, not code. Each leaf `spec.md` describes one page of the recommended
Next.js route tree in enough detail for a coding agent to build it without re-researching:
route, nav placement, purpose, primary user + JTBD, concrete functionality, the **real**
capability contracts it invokes, which of the four data stores it touches, empty/loading/
error states, what exists today (keep / rename / move / merge / new), and how the page
serves the product wedge.

Inputs it was authored from: the current-state route inventory (`84` page files, `61`
real content pages, a 3-mode sidebar, `308` registered capability contracts of which only
`57` declare an `app` layer, leaving `251` operable only via API/MCP), and
[`docs/VISION.md`](../VISION.md) — the "metered, governed, graph-grounded control plane
for teams that build and **resell** AI agents" north star.

> Note on route names: the old `studio/` segment was renamed to `workbench/` on `main`;
> this IA uses the current `workbench/` names. Doc folders mirror the **recommended**
> route tree (readable segments: `workspace/`, `org/`, `account/`).

---

## A. High-level UX recommendation

### The problem with today's IA

The current app is competent but **hides its own thesis.** The three things the vision
says Oxagen *is* — the metering→billing loop, the governed accountability chain, and the
graph grounding — are present in the codebase but scattered, buried, or headless:

- The **metering→billing loop** (`billing.usage.breakdown` → Stripe) is a single tab
  three clicks deep under org billing. The **reseller** half of the wedge — meter observed
  usage and re-bill *your* customers — has no surface at all.
- The **accountability chain** (every capability is a typed contract binding identity →
  knowledge scope → permitted action → commercial terms → verified outcome → audit record)
  is the product's core differentiator, yet there is **no page anywhere** that makes a
  contract legible as that enforced object. The 308 contracts are introspectable only via
  a repo script (`pnpm check:manifest`).
- **251 capabilities have no human surface.** Whole families are invisible: `automation.*`
  (6, zero UI — the sidebar's own header comment names an intended "Automation" item that
  was never built), `repo.*` (13), subagent fan-out / fleet (8), `workflow.*` (3), the eval
  write path, and every connector wizard except GitHub's.
- **Live defects:** the entire Evals surface (2 pages, real backend) is a **nav orphan** —
  no sidebar entry, no in-page link. A marketplace bulk-install binding is fictional
  (`void installBulkAction`). The graph explorer has no node browse/search. `knowledge/repos`
  is misnamed (it lists data-source connections, not git repos). 11 legacy redirect shims
  and a latent sidebar 404 trace three unfinished IA migrations.
- **Systemic reverse-parity drift:** large working families (`schema.*`, `connection.*`,
  `semantic.*`, `billing.*`, `audit.log.query`, `agent.execution.*`) power real pages but
  their contracts omit `app`, so `check:ui-parity --strict` can't protect those pages.

### The recommended model — organize the app around the wedge

Keep the three scopes (**workspace** = daily operation, **org** = governance + money,
**account** = the person), but re-group each scope's nav so the vision is the map:

**Workspace scope** — *build, ground, operate, observe:*

- **Ask** (front door, unchanged) · **Overview** (new: a metering-forward home)
- **Knowledge** (grounding): Sources · Graph · Inference · Ontology · Memory — promote the
  graph to a first-class browsable/queryable surface; move the ontology/schema builder out
  of Settings into Knowledge where grounding belongs.
- **Workbench** (build): Agents · Tools · Sandboxes · **Repos** (new) — the whole `repo.*`
  family gets a home.
- **Automations** (new primary): Automations · Triggers · Workflows — the biggest missing
  section, human-gated activation front and center.
- **Activity** (observe): Runs · **Fleet** (new: subagent fan-out lineage) · **Evals**
  (orphan fixed by co-location + nav wiring).
- **Marketplace** · **Settings** (consolidated 10 tabs → General · Agent Defaults ·
  Environments).

**Org scope** — *govern and monetize (the two moats):*

- **People**
- **Governance** (new group): a hub that renders the six links of the accountability chain
  as a board, a **Capability & Contract catalog** (the flagship — the "one enforced object"
  made inspectable), Access (sessions/reviews), and Policies.
- **Security**: posture · Audit (the audit-record link).
- **Billing & Revenue**: Subscription · **Usage/Metering** (the wedge dashboard) · Invoices ·
  **Revenue/Reseller** (new — the clearest market whitespace: meter → re-bill *your*
  customers).
- **Developer** (MCP · Tokens) · **Settings**.

Every new/relocated surface is justified against a specific vision drift test in its
`spec.md`; fast-follow areas the vision declines to fight on the front line (evals,
connector breadth) are deliberately kept thin and in service of the wedge (e.g. Evals is a
P1 only to fix a *shipped orphan*, not to invest in eval tooling; connector cards route
into a governed grounding wizard rather than becoming a breadth play).

### Top 5 UX changes vs today

1. **Surface the money loop.** Elevate Usage/Metering and add a **Revenue/Reseller** surface
   so a customer can meter observed agent usage and re-bill their own customers — the
   vision's clearest whitespace, and a real new build (contracts required).
2. **Make governance a place.** New **Governance** group with a **Capability & Contract
   catalog** that renders each typed contract as identity → scope → action → terms → outcome
   → audit — the differentiator, with no human surface today.
3. **Give the 251 headless capabilities their highest-value UIs.** New **Automations**
   primary section, a **Repos** workbench tab (`repo.*`), a **Fleet** subagent-lineage view,
   and a real **Connect-a-source wizard** for every connector (not just GitHub).
4. **Fix the live defects.** Un-orphan **Evals** (nav + inbound links + the missing write
   path); build the real bulk-install UI; promote the graph explorer to a browsable/
   queryable **Graph** page with node search; rename the misleading `knowledge/repos` →
   **Sources**; collapse the 11 legacy redirect shims and the latent sidebar 404.
5. **Consolidate and correct parity.** Collapse Workspace Settings' 10 tabs into 3
   (General · Agent Defaults · Environments), move the ontology into Knowledge, and declare
   `app` on the drifted families so `check:ui-parity --strict` protects the pages that
   already work.

---

## B. Index — every page spec

Grouped by recommended nav scope. Each link is the page's `spec.md`; the real Next.js route
appears in the file's header.

### System & entry

- [`root/spec.md`](./root/spec.md) — Identity dispatcher at `/` (auth → org → workspace redirect).
- [`auth/spec.md`](./auth/spec.md) — All unauthenticated surfaces: login, signup, forgot/reset password, two-factor, verify.
- [`onboarding/spec.md`](./onboarding/spec.md) — Org creation (`/new-organization`) and workspace creation (`/{orgSlug}/new-workspace`).
- [`system/spec.md`](./system/spec.md) — Machine/OAuth landings: loopback PKCE authorize and GitHub App setup.

### Account scope (`/account`)

- [`account/spec.md`](./account/spec.md) — Tabbed account settings: Profile · Preferences · Security (MFA/sessions) · Privacy (GDPR).

### Workspace scope — operate & observe

- [`workspace/overview/spec.md`](./workspace/overview/spec.md) — New metering-forward workspace home (spend, runs, grounding, health).
- [`workspace/ask/spec.md`](./workspace/ask/spec.md) — Canonical conversation surface (chat, approvals, plans, budget, background tasks).
- [`workspace/activity/spec.md`](./workspace/activity/spec.md) — Runs list with a Runs · Fleet · Evals tab strip (also un-orphans Evals).
- [`workspace/activity/run/spec.md`](./workspace/activity/run/spec.md) — One run: span-tree trace, file lineage, failure-debug frame.
- [`workspace/activity/fleet/spec.md`](./workspace/activity/fleet/spec.md) — New subagent fan-out / fleet observability with per-child lineage + cost.
- [`workspace/evals/spec.md`](./workspace/evals/spec.md) — Eval datasets + runs; fixes the orphan and adds the create/run write path.
- [`workspace/evals/run/spec.md`](./workspace/evals/run/spec.md) — Eval run detail: scores, pass rate, per-item results.

### Workspace scope — Knowledge (grounding)

- [`workspace/knowledge/sources/spec.md`](./workspace/knowledge/sources/spec.md) — Data-source connections list (renamed from misleading `knowledge/repos`).
- [`workspace/knowledge/sources/connect/spec.md`](./workspace/knowledge/sources/connect/spec.md) — New multi-step connector wizard (credentials → preview → mapping) for every connector.
- [`workspace/knowledge/graph/spec.md`](./workspace/knowledge/graph/spec.md) — Promoted Graph page: WebGL explorer + node browse/search + Cypher/NL query console.
- [`workspace/knowledge/graph/node/spec.md`](./workspace/knowledge/graph/node/spec.md) — Node detail / citation deep-link target (label-first, inspectable).
- [`workspace/knowledge/inference/spec.md`](./workspace/knowledge/inference/spec.md) — Human review queue for LLM-inferred semantic edges/relationships.
- [`workspace/knowledge/ontology/spec.md`](./workspace/knowledge/ontology/spec.md) — Ontology/schema builder (moved from Settings): labels, versions, enforcement.
- [`workspace/knowledge/memory/spec.md`](./workspace/knowledge/memory/spec.md) — AgentMemory browser: CRUD, promote, citations, evidence, import.

### Workspace scope — Workbench (build)

- [`workspace/workbench/agents/spec.md`](./workspace/workbench/agents/spec.md) — Agent definitions list with lifecycle/deployment/version state.
- [`workspace/workbench/agents/builder/spec.md`](./workspace/workbench/agents/builder/spec.md) — Agent builder (create + edit): equip pools, environments, triggers, publish/deploy.
- [`workspace/workbench/tools/spec.md`](./workspace/workbench/tools/spec.md) — Read-only catalog of every equipable agent tool.
- [`workspace/workbench/tools/skills/spec.md`](./workspace/workbench/tools/skills/spec.md) — Installed skills + AI authoring, versions, activation, export.
- [`workspace/workbench/tools/mcp/spec.md`](./workspace/workbench/tools/mcp/spec.md) — External MCP servers: register, install, credential reauth, install snippets.
- [`workspace/workbench/tools/capabilities/spec.md`](./workspace/workbench/tools/capabilities/spec.md) — Installed capability packs + registry management (workspace-scoped).
- [`workspace/workbench/sandboxes/spec.md`](./workspace/workbench/sandboxes/spec.md) — Durable sandbox sessions list + warm-a-sandbox.
- [`workspace/workbench/sandboxes/session/spec.md`](./workspace/workbench/sandboxes/session/spec.md) — One sandbox: terminal, file browser, snapshot, stop.
- [`workspace/workbench/repos/spec.md`](./workspace/workbench/repos/spec.md) — New Repos surface for the headless `repo.*` family (sync, create, fork, edit→PR).
- [`workspace/workbench/repos/repo/spec.md`](./workspace/workbench/repos/repo/spec.md) — New repo detail: branches, PRs, diffs, CI, file commits, file locks.

### Workspace scope — Automations (new section)

- [`workspace/automations/spec.md`](./workspace/automations/spec.md) — Automations list with human-gated enable; the biggest missing UI section.
- [`workspace/automations/automation/spec.md`](./workspace/automations/automation/spec.md) — Automation editor: trigger config, playbook, audited run history.
- [`workspace/automations/triggers/spec.md`](./workspace/automations/triggers/spec.md) — Workspace-wide agent trigger board (manual/cron/event).
- [`workspace/automations/workflows/spec.md`](./workspace/automations/workflows/spec.md) — Parallel workflow/swarm runs with typed lineage + cost.

### Workspace scope — Marketplace & Settings

- [`workspace/marketplace/agent-tools/spec.md`](./workspace/marketplace/agent-tools/spec.md) — Install catalog for skills/MCP/capabilities; fixes the fictional bulk-install.
- [`workspace/marketplace/integrations/spec.md`](./workspace/marketplace/integrations/spec.md) — Connector catalog that routes into the governed connect wizard.
- [`workspace/settings/general/spec.md`](./workspace/settings/general/spec.md) — Workspace General + read-only Members tabs.
- [`workspace/settings/agent-defaults/spec.md`](./workspace/settings/agent-defaults/spec.md) — Consolidated Models · Budget · Prompts · Memory-policy defaults.
- [`workspace/settings/environments/spec.md`](./workspace/settings/environments/spec.md) — Environments, encrypted secrets vault, sandbox templates.

### Org scope — People

- [`org/members/spec.md`](./org/members/spec.md) — Members + pending invites, seat usage, role changes (identity link).

### Org scope — Governance (new group)

- [`org/governance/spec.md`](./org/governance/spec.md) — New governance hub: the six accountability-chain links as a board.
- [`org/governance/capabilities/spec.md`](./org/governance/capabilities/spec.md) — Flagship: the org-wide typed-contract catalog (identity→scope→action→terms→outcome→audit).
- [`org/governance/policies/spec.md`](./org/governance/policies/spec.md) — New IAM roles, entitlements, and MCP auth alerts (needs new contracts).
- [`org/access/spec.md`](./org/access/spec.md) — Enterprise session manager + quarterly access reviews (SOC 2 CC6 evidence).

### Org scope — Security

- [`org/security/spec.md`](./org/security/spec.md) — Posture dashboard: Overview · MFA · Compliance · Trust (honest about unbuilt controls).
- [`org/security/audit/spec.md`](./org/security/audit/spec.md) — Filterable, exportable audit log — the audit-record end of the chain.

### Org scope — Billing & Revenue

- [`org/billing/subscription/spec.md`](./org/billing/subscription/spec.md) — Subscription, credits, plans, payment methods (the Stripe side of the loop).
- [`org/billing/usage/spec.md`](./org/billing/usage/spec.md) — Metering wedge dashboard (ClickHouse observed usage, priced).
- [`org/billing/invoices/spec.md`](./org/billing/invoices/spec.md) — Stripe-synced invoice history.
- [`org/billing/revenue/spec.md`](./org/billing/revenue/spec.md) — New Reseller surface: attribute usage to customers and re-bill them (the whitespace).

### Org scope — Developer & Settings

- [`org/developer/mcp/spec.md`](./org/developer/mcp/spec.md) — MCP connect page: keyed install snippets for Claude Code/Desktop/Cursor.
- [`org/developer/tokens/spec.md`](./org/developer/tokens/spec.md) — API key create/revoke/rotate (scoped identity, audited).
- [`org/settings/spec.md`](./org/settings/spec.md) — Org profile (General) + org GDPR (Privacy); collapses legacy shims.
