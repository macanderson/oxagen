# Information Architecture

Archived spec & plan — status: partially shipped (audited 2026-07-03).

> **Status: Partially shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The Information Architecture specification describes a comprehensive v2 app structure with workspace zones (Ask, Knowledge, Automation, Activity, Settings, Tools/Studio) and org zones (Members, Access, Security, Billing, Developer). The spec is marked "proposed" and implementation was attempted then rolled back. Core infrastructure (contract system with 490+ contracts, IAM resolver, account zone, basic org routes) is in place, but Automation and Activity workspace zones that were added June 15 were removed June 30, 2026. The sidebar exposes only Ask, Knowledge, Marketplace, and Settings. Access control matrices and many org security pages remain as mocks or partially wired stubs.

**Implementation evidence**

- packages/oxagen/src/contracts/: ~490 contract files implementing the contract invocation boundary described in spec section 9
- packages/oxagen/src/iam/resolve.ts: IAM resolution order implementation per spec section 12
- apps/app/src/app/account/profile|security|privacy|preferences: Full personal account scope zone per spec section 7
- apps/app/src/app/[orgSlug]/members: Organization members roster page per spec section 6
- apps/app/src/app/[orgSlug]/access/sessions|reviews: Partial Access zone with Sessions and Reviews tabs; missing Grants/Roles/Policies/Requests/Identities per spec section 6
- apps/app/src/app/[orgSlug]/security|billing|developer: Org-level routes present but many as placeholder stubs per 2026-06-30 cleanup (commit d218e0a7)
- apps/app/src/app/[orgSlug]/[workspaceSlug]/ask: Workspace Ask front-door zone implemented per spec section 5
- apps/app/src/app/[orgSlug]/[workspaceSlug]/knowledge: Workspace Knowledge zone with repos/nodes/explore/inference subroutes
- apps/app/src/lib/sidebar.ts: Sidebar configuration showing only Ask, Knowledge, Marketplace, Settings for workspace mode (no Automation or Activity items present)
- docs/specs/information-architecture/spec.md changelog: 2026-06-15 changelog entry documents implementation realignment adding Automation/Activity; 2026-06-30 commit d218e0a7 removed both zones entirely

**Known gaps at time of archive**

- Workspace Automation zone (/:org/:ws/automation with Agents, Playbooks, Events, Triggers tabs) - implemented June 15, removed June 30
- Workspace Activity zone (/:org/:ws/activity with Runs, Approvals, Audit tabs) - implemented June 15, removed June 30
- Workspace Tools/Studio sidebar item and /:org/:ws/tools/studio route
- Access zone capability matrix UI (/:org/access/grants tab) per spec section 6
- Access zone roles builder UI (/:org/access/roles tab) per spec section 6
- Access zone policies UI (/:org/access/policies tab) per spec section 6
- Access zone requests/JIT queue UI (/:org/access/requests tab) per spec section 6
- Access zone identities directory (/:org/access/identities with Humans/Agents/Service sub-tabs) per spec section 6
- Organization Security fully wired pages (SSO, SCIM, MFA configuration - currently stubs)
- Developer zone tabs (MCP, Webhooks, Docs, Tokens) - partially stubbed or missing
- Trigger detail page and model UI (spec section 10)
- Grant, Principal, Trigger data models and API/MCP capabilities per spec sections 9 and 10

**Source documents** (archived verbatim below)

- `docs/specs/information-architecture/spec.md`

## Spec — `spec.md`

## Oxagen v2 — Information Architecture

Canonical specification for the v2 app's information architecture. This is the source of truth that drives the app shell, sidebar, route layout, ACL surface, and every user-facing nav decision in `apps/app`.

Status: **proposed**, locked by product. Implementation tracked under `docs/epics/`.

---

### 1. Principles

| Principle                           | Implication                                                                                                                                                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI is the substrate, not a page** | Persistent "Ask" affordance from every screen; chat is a drawer first, a route second.                                                                                                                                                   |
| **Contracts are the spine**         | Every governable action is a contract in `@oxagen/oxagen`. The contract registry drives the sidebar, the ACL matrix, the agent capability list, the audit log, and the auto-generated docs. There is no path to action that bypasses it. |
| **One principal model**             | Humans, agents, and service accounts are all principals with the same shape. One matrix governs all three.                                                                                                                               |
| **Three scopes, no more**           | Personal (the user) → Org (governance) → Workspace (operations). URL, nav, and audit trails all reflect those three.                                                                                                                     |
| **Generative over enumerative**     | Long-tail list/filter views are produced on demand by agents and pinnable, not pre-built as routes. Static nav is reserved for daily operational surfaces.                                                                               |
| **Inherited-with-override IAM**     | Org sets the rails; workspace owners can tighten within those rails. Workspaces can never expand what org has locked.                                                                                                                    |

---

### 2. Scope hierarchy

```
Personal     → the human using Oxagen
   └─ Org    → the customer entity that owns billing + governance
        └─ Workspace → the operational unit where agents work
```

URL shape:

```
/                                       redirect by session
/(auth)/{login,signup,verify,forgot,reset,invites}
/(onboarding)/new-organization
/account/...                            personal scope
/{orgSlug}/...                          org scope
/{orgSlug}/{workspaceSlug}/...          workspace scope
/share/{token}                          public, unauthenticated
```

`orgSlug` replaces the legacy `tenantSlug`. The word "tenant" appears nowhere in v2 user-facing text.

---

### 3. App shell shape

```
┌────────────────────────────────────────────────────────────────────┐
│  ⬡ Oxagen   [ Org ▾ ]  /  [ Workspace ▾ ]      Ask anything…   🔔 👤 │ ← topbar
├──────────────┬─────────────────────────────────────────────────────┤
│              │                                                     │
│   sidebar    │                  main content                       │
│              │                                                     │
│              │                                ┌──────────────────┐ │
│              │                                │   Ask drawer     │ │
│              │                                │  (right slide-in)│ │
│              │                                └──────────────────┘ │
└──────────────┴─────────────────────────────────────────────────────┘
```

#### Topbar slots — left to right

| Slot | Element                | Notes                                                                                                                                           |
| ---- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Brand mark             | Returns to workspace home.                                                                                                                      |
| 2    | **Org switcher**       | Dropdown listing all orgs the user belongs to. "New organization" link in footer.                                                               |
| 3    | **Workspace switcher** | Dropdown listing workspaces in the current org. "New workspace" link in footer. Hidden when no workspace is active (org-scoped pages).          |
| 4    | **Ask bar** (center)   | Universal input. Routes by intent: question → chat drawer, action → execute, navigation → push route. Replaces the legacy `⌘K` command palette. |
| 5    | **Notifications bell** | Drawer; system + workflow notifications. No standalone `/notifications` route.                                                                  |
| 6    | **User avatar**        | Dropdown: Profile, Sign out, Theme, Help. Profile entry deep-links to `/account/profile`.                                                       |

#### Sidebar

Single column. Two visible sections (Workspace + Org) plus a de-emphasized Tools group at the bottom. Visible on `lg+`, collapses to a drawer on mobile. Shell `<main>` scrolls; sidebar and topbar are sticky.

#### Ask drawer

Right-side slide-in, full-height, 480px wide. Opens from the topbar Ask bar or any page-level "Ask about this" button. Carries page entity context automatically. Backed by the same `ChatShellClient` that powers `/ask`.

---

### 4. Complete sidebar tree

```
Workspace
├─ Ask                  /:org/:ws/ask                      ← front door
├─ Knowledge            /:org/:ws/knowledge
│   ├─ Sources           /sources                          data connections, ingest
│   ├─ Graph             /graph                            ontology explorer, merge policy
│   └─ Memories          /memories                         rules + facts + suggestions
├─ Automation           /:org/:ws/automation
│   ├─ Agents            /agents                           agent configs (principals)
│   ├─ Playbooks         /playbooks                        playbook authoring + versions
│   ├─ Events            /events                           saved filters over the graph (signals)
│   └─ Triggers          /triggers                         cause (event|schedule|webhook|manual) → effect
├─ Activity             /:org/:ws/activity
│   ├─ Runs              /runs                             live + historical runs (incl. Studio)
│   ├─ Approvals         /approvals                        HITL queue
│   └─ Audit             /audit                            workspace-scoped slice of org audit
└─ Settings             /:org/:ws/settings
    ├─ General           /general
    ├─ Members           /members                          workspace ACL (scoped grants editor)
    ├─ Model Keys        /model-keys                       BYOK at workspace scope
    └─ Integrations      /integrations                     workspace webhooks

Tools                                                       ← visually de-emphasized
└─ Studio               /:org/:ws/tools/studio              compose UX for content gen

Organization
├─ Members              /:org/members                       people roster + effective grants
├─ Access               /:org/access
│   ├─ Grants            /grants                           capability × principal matrix
│   ├─ Roles             /roles                            role builder + versioning
│   ├─ Policies          /policies                         conditional grants, sensitivity tags
│   ├─ Requests          /requests                         JIT access requests + approval routing
│   ├─ Sessions          /sessions                         active sessions, force-revoke
│   └─ Identities        /identities
│       ├─ Humans         /humans
│       ├─ Agents         /agents
│       └─ Service        /service                         API tokens governed as service principals
├─ Security             /:org/security
│   ├─ SSO               /sso                              SAML 2.0 + OIDC
│   ├─ SCIM              /scim                             directory sync
│   ├─ MFA               /mfa                              enforcement policies
│   ├─ Audit             /audit                            append-only stream, SIEM export
│   ├─ Compliance        /compliance                       SOC2 + ISO 27001 dashboards
│   └─ Incidents         /incidents                        break-glass log
├─ Billing              /:org/billing                       subscription, usage, invoices
└─ Developer            /:org/developer
    ├─ MCP               /mcp                              unified install for all MCP clients
    ├─ Webhooks          /webhooks                         outbound routing
    ├─ Docs              /docs                             capability catalog (read-only)
    └─ Tokens            /tokens                           deep-link to Access/Identities/Service
```

**Counts:** 4 primary workspace items + 1 Tools group + 4 org items = 9 sidebar entries. Everything else is tabbed within.

#### Switcher placement summary

- **Org switcher**: topbar slot 2. Always visible (the user is always inside an org once authed).
- **Workspace switcher**: topbar slot 3. Visible only when a workspace is in scope; hidden on org-only routes (`/:org/members`, `/:org/billing`, etc.).
- **User profile entry**: topbar slot 6 (avatar dropdown). Routes to `/account/profile`. Personal scope is never reached through the sidebar.

---

### 5. Workspace zones

#### Ask — _"How do I get something done?"_

Front door. Chat surface + conversation list. Also reachable as the right-side drawer from any page.

#### Knowledge — _"What do my agents know?"_

| Tab          | Purpose                                                                                 | First-class objects                   |
| ------------ | --------------------------------------------------------------------------------------- | ------------------------------------- |
| **Sources**  | Authenticated data connections; ingest pipelines; catalog dialog for adding new sources | `Connection`, `Connector` (catalog)   |
| **Graph**    | Ontology explorer (2D/3D), node detail, merge policy panel                              | `OntologyNode`, `Edge`, `MergePolicy` |
| **Memories** | Workspace-scoped rules + facts + agent-proposed suggestions                             | `Memory{kind: rule\|fact\|note}`      |

Memories are **workspace-scoped only**. No cross-workspace promotion path in v2.

#### Automation — _"What can my agents do — and when?"_

| Tab           | Purpose                                                                        | First-class objects           |
| ------------- | ------------------------------------------------------------------------------ | ----------------------------- |
| **Agents**    | Agent configurations. Each agent has a principal — links to Access for grants. | `Agent` (also a `Principal`)  |
| **Playbooks** | Authoring, versioning, parameter schemas, approval-required flag               | `Playbook`, `PlaybookVersion` |
| **Events**    | Saved filters over the ontology; observable signals; reusable across triggers  | `EventDef`                    |
| **Triggers**  | Cause → effect. Cause is `event`, `schedule`, `webhook`, or `manual`.          | `Trigger`                     |

Schedules are not a separate tab. Schedule is a `cause.kind` on a Trigger. See §10 for the Trigger model.

#### Activity — _"What did my agents do?"_

| Tab           | Purpose                                                                                   | First-class objects |
| ------------- | ----------------------------------------------------------------------------------------- | ------------------- |
| **Runs**      | All agent runs (chat + triggered + scheduled + Studio generations). Filter chips by kind. | `Run`               |
| **Approvals** | Human-in-the-loop queue for plan approvals and `require-approval` capabilities            | `Approval`          |
| **Audit**     | Workspace-filtered view of the org-wide audit log                                         | `AuditEvent`        |

#### Settings — workspace config

| Tab              | Purpose                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| **General**      | Workspace name, archive, hard delete                                         |
| **Members**      | Workspace ACL editor — scoped grants, role assignments within this workspace |
| **Model Keys**   | BYOK at workspace scope                                                      |
| **Integrations** | Workspace-level webhook destinations                                         |

Workspace **Members** is a real ACL surface, not just a roster — it shows the grants matrix filtered to this workspace, with org-locked cells indicated. See §9 (Resolution order) and §13 (UI for inherited-with-override).

#### Tools (de-emphasized group)

| Item       | Purpose                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------ |
| **Studio** | Compose UX for content generation (prompt → preview → library). Runs surface in `Activity/Runs`. |

Future tools (dataset labeler, evaluation harness) land here. Keeps optional surfaces from competing visually with the three operational zones.

---

### 6. Org zones

#### Members

People roster. Per-row: name, email, role assignments, status (active / pending / suspended), MFA status, last login. Per-user detail panel surfaces effective grants summary with a deep link to `/:org/access/grants` pre-filtered by that user.

#### Access — capability ACL

The spine of the IAM model. Tabs:

| Tab            | Purpose                                                                                                                                                                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Grants**     | Capability × principal matrix. Rows grouped by domain (`knowledge.*`, `automation.*`, `activity.*`, `admin.*`). Cell states: `granted`, `inherited`, `denied`, `require-approval`. Columns toggleable: roles / humans / agents / services. Scope toggle: `Org-wide` (default) / `Per workspace`.                  |
| **Roles**      | Custom role builder + role versioning. Default role set described in §11. IdP groups (from SCIM) map to roles.                                                                                                                                                                                                    |
| **Policies**   | Conditional grants — time windows, IP allowlists, attribute predicates. Sensitivity tags applied to capabilities; tag-based default policies (e.g., "all `destructive: true` capabilities require approval"). Policies carry an `enforced` flag (workspace cannot override) vs `default` (workspace can tighten). |
| **Requests**   | JIT access request queue. Submit a request → routed by policy → granted with TTL → auto-expired.                                                                                                                                                                                                                  |
| **Sessions**   | Active sessions across all principals; force-revoke; session policies (max age, idle timeout, geographic limits).                                                                                                                                                                                                 |
| **Identities** | The principal directory. Sub-tabs: Humans, Agents, Service. API tokens live here as scoped credentials of a service identity.                                                                                                                                                                                     |

#### Security

| Tab            | Purpose                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| **SSO**        | SAML 2.0 + OIDC IdP configuration. Group claim mapping → role assignment.                          |
| **SCIM**       | SCIM 2.0 provisioning status, attribute mapping, sync history.                                     |
| **MFA**        | Enforcement policy (required / optional / by-role), accepted factors, passkey config.              |
| **Audit**      | Append-only audit stream. Filterable. SIEM export (Splunk / Datadog / S3 / generic JSONL webhook). |
| **Compliance** | SOC2 + ISO 27001 control coverage dashboards. Capability coverage report. Export-ready.            |
| **Incidents**  | Break-glass procedure log. Incident routing rules. Alert subscriptions.                            |

#### Billing

Subscription summary, credit balance, usage chart, plan grid, invoice list. Lives at `/:org/billing` (promoted from the legacy `/:org/settings/billing`).

#### Developer

| Tab          | Purpose                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP**      | Unified install for Claude Code, Cursor, Claude Desktop, Codex, VS Code, ChatGPT, Windsurf.                                                    |
| **Webhooks** | Outbound webhook routing — events / runs / audit → external systems.                                                                           |
| **Docs**     | Capability catalog auto-generated from the contract registry. Stable URLs per capability for support escalations and audit log click-throughs. |
| **Tokens**   | Convenience deep-link into `/access/identities/service` with a "Create API key" CTA.                                                           |

---

### 7. Personal scope — `/account`

Distinct from org scope. The user as a person, not as an org member.

```
Account
├─ Profile              /account/profile        contact details, photo, timezone, locale
├─ Security             /account/security       passwords, MFA, passkeys, linked OAuth accounts, login sessions
├─ Cases                /account/cases          support tickets, account events, security alerts
├─ Notifications        /account/notifications  channel + topic preferences
└─ Privacy              /account/privacy        GDPR export, GDPR delete, consent, retention preview
```

The personal scope is reached only via the topbar avatar dropdown — never from the sidebar.

#### Profile

Display name, primary email, phone (optional, security-only), pronouns, photo, timezone, locale. Edits propagate to all org memberships.

#### Security

| Section             | Contents                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Passwords**       | Change password; passkey enrollment; passwordless toggle                                                                     |
| **MFA**             | Active factors, recovery codes regeneration                                                                                  |
| **Linked accounts** | Google, GitHub, Microsoft, custom OIDC linkages; unlink                                                                      |
| **Sessions**        | All active sessions (device, IP, last activity, location); revoke individual; revoke all-other-sessions; sign-out everywhere |

Personal session controls coexist with org-wide `/access/sessions`. The org view shows every session across every principal; the personal view shows only the current user's sessions and is self-service.

#### Cases

Personal account events the user might need to inspect or reference. Examples: password reset triggered, MFA factor added/removed, SSO link change, support tickets opened (with current status), security alerts received, data-access requests submitted. Each row deep-links to relevant detail. Cases are the user-visible view; the org-wide audit log remains the system-of-record.

#### Notifications

Per-topic and per-channel preferences. Topics: workflow events, approval requests, security alerts, billing reminders, product updates. Channels: in-app, email, mobile push (when mobile ships).

#### Privacy — GDPR-grade controls

| Control                    | Behavior                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Export data**            | Generates a complete JSON archive of all personal data: profile, sessions, cases, audit events scoped to the user, memories the user authored, conversations they participated in, notification history. Asynchronous job; email delivery of signed download link; 7-day expiry.                                                 |
| **Delete personal data**   | Initiates account deletion flow. Two-step confirmation. 30-day soft-delete window (cancelable). On hard-delete: PII removed, audit events anonymized to `<deleted-user>` with stable user-id hash retained for referential integrity. Cannot be deleted if user is the sole **Owner** of an org — must transfer ownership first. |
| **Consent settings**       | Per-purpose consent toggles (product analytics, error telemetry, model training opt-out). Default: model training opt-out is ON.                                                                                                                                                                                                 |
| **Data retention preview** | "Your data is retained for X days after deletion / Y days for audit / Z days for billing" — shows the operative retention policy so users can make informed decisions.                                                                                                                                                           |

GDPR export + delete are also exposed as capabilities (`privacy.export.create`, `privacy.delete.initiate`) so they appear in the audit log and the ACL matrix. A user always has the grant for their own data. Admin-initiated exports on behalf of a user (e.g., for legal hold) require an explicit grant and route through the approval queue.

---

### 8. AI-driven affordances

The IA above describes the _structure_. AI changes how users _traverse_ it.

| Affordance                      | Behavior                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ask bar (topbar)**            | Universal entry. Routes questions to chat, actions to execution, nav requests to push. Carries current page context implicitly.                                                                                                                         |
| **Ask drawer**                  | Right-side slide-in opened from any page. Auto-scoped to the page's entity. Persists across navigation within a session.                                                                                                                                |
| **Page-level "Ask about this"** | On every detail page (a Run, a Playbook, an OntologyNode). Opens the drawer pre-loaded with that entity.                                                                                                                                                |
| **Generative views**            | When the user asks for a filtered list that doesn't map to a static route ("show me playbooks that failed last week with cost > $5"), the agent generates the view inline. Pinnable as a saved view; pinned views surface in the relevant Activity tab. |
| **Capability handoff**          | Inside chat, when an agent wants to invoke a capability the current user lacks, it submits an Access Request automatically. The request appears in `/:org/access/requests` for the approver and in `/account/cases` for the requester.                  |

---

### 9. Cross-cutting models

#### Principal

Unifies humans, agents, services. One audit event format. One grant model. One UI matrix.

```ts
Principal {
  id, kind: 'human' | 'agent' | 'service',
  display, status, mfa?, idp_subject?,
  parent_roles[], direct_grants[], effective_grants[],
  active_sessions[], audit_pointer
}
```

#### Grant

```ts
Grant {
  principal, capability, scope: 'org' | 'workspace:<id>',
  effect: 'allow' | 'deny' | 'require-approval',
  conditions: PolicyExpr?,
  granted_by, granted_at, expires_at?, approval_chain[]
}
```

#### Trigger

```ts
Trigger {
  id, name, status: 'enabled' | 'disabled',
  cause: {
    kind: 'event'    → { eventDefId, filterExpr? }
        | 'schedule' → { cron, timezone }
        | 'webhook'  → { url, hmacSecret }
        | 'manual'   → { invocationToken }
  },
  effect: {
    target: { kind: 'agent' | 'playbook', id, version? },
    parameters: object,
    approvalRequired: boolean,
  },
  guardrails: { rateLimit, retryPolicy, conditionalBypass? },
  principal,           // the trigger acts as a principal; this is its identity
  effectiveGrants[],   // pulled from principal at invocation time
}
```

Single cause per Trigger in v2. Multi-cause is a future enhancement (`cause` → `causes: Cause[]`) that does not break the model.

#### Capability invocation boundary

Every contract call passes through `contract.invoke(rawCtx, input)`. No alternate path. The handler is captured inside `defineContract()` and unreachable from outside — enforcement is structural, not a wrapper that can be omitted. A lightweight CI guard confirms each `defineContract` call is exported in its package's `contracts` array; there is nothing else to guard.

```ts
// packages/oxagen/src/contracts/organization.create.ts
export const organizationCreate = defineContract({
  id: "organization.create",
  domain: "organization",
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ ... }),
  output: z.object({ ... }),
  handler: async (ctx, input) => { /* … */ },
});

// call site (server action)
await organizationCreate.invoke(rawCtx, input);
```

#### Audit event

```ts
AuditEvent {
  id, occurred_at,
  human_principal?, acting_principal,  // delegated-context captures both
  capability, scope, outcome: 'allow' | 'deny' | 'pending-approval',
  target_ref?, payload_hash, ip, ua,
  request_id, correlation_id
}
```

Immutable. Append-only. Hash-chained for tamper evidence. Exported to SIEM in near-real-time.

---

### 10. Trigger detail page

```
┌─────────────────────────────────────────────────────┐
│  Trigger: "Auto-investigate high-value churn risk"  │
├─────────────────────────────────────────────────────┤
│  WHEN                                               │
│   ┌─────────────────────────────────────────────┐  │
│   │ Cause type:  [ Event ▾ ]                    │  │
│   │              Event | Schedule | Webhook |…  │  │
│   ├─────────────────────────────────────────────┤  │
│   │  Event:  ChurnRiskDetected ▾                │  │
│   │  Filter: tier = 'enterprise' AND mrr > 10k  │  │
│   └─────────────────────────────────────────────┘  │
│                                                     │
│  WHAT                                               │
│   ┌─────────────────────────────────────────────┐  │
│   │ Run playbook: churn-investigate v3 ▾         │  │
│   │ Parameters:  { account_id: $event.account } │  │
│   │ Approval required: ☑                         │  │
│   └─────────────────────────────────────────────┘  │
│                                                     │
│  GUARDRAILS                                         │
│   Rate limit: 50/hr · Retries: 3 · Skip if drill   │
│                                                     │
│  THIS TRIGGER'S PRINCIPAL                           │
│   churn-investigator-bot                            │
│   45 of 82 capabilities granted ↗                  │
│                                                     │
│  RECENT RUNS (12)        →  view in Activity/Runs  │
└─────────────────────────────────────────────────────┘
```

Cause selector at top morphs the form below. Schedule case shows a cron input + human-readable preview. Webhook case mints a URL and shows curl examples. Manual case shows a "Run now" button that doubles as a test affordance.

---

### 11. Default role set

All default roles use **single-word labels**, mirroring the conventions in Google Workspace, Vercel, Linear, and Notion (Owner / Admin / Member / Viewer / Billing / Compliance).

#### Org-scoped roles

| Role           | What it can do                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| **Owner**      | Everything, including transfer-ownership, billing, delete-org                                                   |
| **Admin**      | Everything except destructive org-level ops                                                                     |
| **Compliance** | IAM, SSO/SCIM, audit, and security configuration only; read-only on operational surfaces (separation of duties) |
| **Billing**    | Billing, subscription, invoices, usage; no IAM, no operational access                                           |

#### Workspace-scoped roles

| Role       | What it can do                                                                          |
| ---------- | --------------------------------------------------------------------------------------- |
| **Owner**  | Manage grants within this workspace; manage workspace settings; full operational access |
| **Member** | Run agents, approve, edit playbooks, edit memories, configure triggers                  |
| **Viewer** | Read-only across the workspace                                                          |

Workspace roles use exactly these three labels — **Owner**, **Member**, **Viewer**. No "Operator", "Analyst", "Editor" or other taxonomy. Custom roles remain available via the role builder for customers who need finer divisions.

---

### 12. Resolution order

When `contract.invoke(rawCtx, input)` evaluates a request (via the pure `resolve()` function in `packages/oxagen/src/iam/resolve.ts`):

```
1. workspace deny             (explicit, in this workspace)        → DENY
2. org enforced deny          (org policy, cannot be overridden)   → DENY
3. workspace allow            (explicit, in this workspace)        → ALLOW
4. org enforced allow         (org policy)                         → ALLOW
5. workspace require-approval                                       → PENDING
6. org default grant + workspace silence                            → inherit org
7. role-inherited grant                                             → inherit role
8. no grant                                                         → DENY (default-deny)
```

Two load-bearing properties:

- **Workspace can never _expand_ what org has locked.** The `enforced` flag on an org policy is the locking primitive.
- **Workspace CAN tighten.** If org defaults to allowing `knowledge.export`, a sensitive workspace can override to `deny` or `require-approval`. Defense-in-depth flows downward.

The resolver returns a structured trace alongside the decision; the trace is what powers "why was this denied?" inspections in the audit UI.

---

### 13. UI for inherited-with-override

**Grants matrix (`/:org/access/grants`)** has a scope toggle: `Org-wide` (default) / `Per workspace`. In per-workspace view, each cell shows three layered indicators:

```
[org-default] [enforced?] [workspace-override?]
   allow         🔒              ─                 → workspace cannot change (locked)
   allow         ─               deny              → workspace overridden (badge)
   deny          ─               ─                 → inherited from org
```

**Workspace `Settings/Members`** renders the same matrix filtered to that workspace, with locked cells indicated. Workspace Owners see exactly what they can and cannot change. Same React component, different scope filter.

**Policies (`/:org/access/policies`)** gains the `enforced` flag as a primary control. The default for a new policy is `enforced` (safer); admins must explicitly opt in to letting workspaces override.

---

### 14. Audit consequences of scoped grants

Every grant change carries scope:

```ts
auditEvent.scope: 'org' | 'workspace:<id>'
auditEvent.acting_principal: who made the change
auditEvent.target_grant: { principal, capability, before, after }
```

Workspace-scoped grant changes appear in **both** `/:org/security/audit` (full org view) and `/:org/:ws/activity/audit` (workspace slice). Same record, two lenses.

---

### 15. Agents as principals

This is the subtle one. An agent is both an actor (it invokes capabilities) and a delegate (it acts on behalf of a user). v2's identity model supports both:

- **Standalone agent identity** — scheduled and triggered agents have their own principal with their own grants. An agent CAN'T do something its principal isn't allowed to do, regardless of which user defined the playbook.
- **Delegated context** — when a user is in chat, the agent borrows the user's effective grants for the session. Audit records both: `human=alice, agent=research-bot-v3, capability=knowledge.graph.read`.

This is what makes "agents that automate businesses" defensible to a CISO. Every action is attributable to a human chain of custody OR a configured service identity, never to "the AI did it."

---

### 16. v1 → v2 route migration

| v1 surface                                              | v2 destination                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `chat`                                                  | `ask` (also drawer-accessible everywhere)                                                |
| `explore`                                               | `knowledge/graph`                                                                        |
| `sources` / `connections` / `connectors` / `enrichment` | `knowledge/sources`                                                                      |
| `memories` (was `⌘K`-only)                              | `knowledge/memories`                                                                     |
| `events` (super-page)                                   | split into `automation/events`, `automation/triggers`, `activity/runs`, `activity/audit` |
| `automation` (redirect)                                 | `automation` (real)                                                                      |
| `merges` (redirect)                                     | `knowledge/graph` merge policy panel                                                     |
| `learning-log` (redirect)                               | `activity/audit`                                                                         |
| `content-studio`                                        | `tools/studio` (de-emphasized)                                                           |
| `settings/models`                                       | `:ws/settings/model-keys`                                                                |
| `settings/mcp`                                          | `:org/developer/mcp`                                                                     |
| `settings/config`                                       | killed for end users; `:org/developer/docs`                                              |
| `/audit/soc2` (was `⌘K`-only)                           | `:org/security/compliance`                                                               |
| `/api-keys`                                             | `:org/access/identities/service`                                                         |
| `/install-mcp`, `/setup/claude-code`                    | unified at `:org/developer/mcp`                                                          |
| `/notifications`                                        | topbar drawer (no route)                                                                 |
| `/profile`                                              | `/account/profile`                                                                       |
| `/billing/locked`                                       | gate inside `:org/billing`                                                               |
| `/black-tab`                                            | removed from product (internal-only)                                                     |
| `/share/*`                                              | unchanged                                                                                |
| Scheduled agents                                        | folded into `:ws/automation/triggers` (cause: schedule)                                  |

301 redirects ship for every changed route — v1 customers migrating shouldn't hit dead bookmarks.

---

### 17. Implementation order

1. **Contract-check boundary** in `@oxagen/oxagen` (load-bearing — nothing ships without it).
2. **Sidebar shell** with the new tree; existing stub pages relocated to their new tabbed homes.
3. **Knowledge zone** (Sources + Graph + Memories) — primary differentiator.
4. **Access zone** (Grants matrix → Roles → Policies) — required for any enterprise sale.
5. **Identity zone** (SSO + SCIM + MFA) — required for any enterprise sale.
6. **Automation zone** (Agents + Playbooks + Events + Triggers) — daily customer work.
7. **Activity zone** (Runs + Approvals + Audit) — confidence in the automation.
8. **Account zone** (Profile + Security + Cases + Notifications + Privacy) — GDPR + SOC2 prerequisite.
9. **Developer + Studio** — last.

Items 4 + 5 + 8 are the IAM ship. They have to land together or the enterprise pitch isn't credible.

---

### 18. Open questions still pinned

| Question                                                 | Default                                                             | Notes                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Multi-cause triggers (event OR schedule on one trigger)? | **No, single cause day-1.** Duplicate the trigger if you need both. | Schema migration to `causes: Cause[]` is non-breaking when we want it.                   |
| Studio in v2?                                            | **Yes, but de-emphasized** under Tools.                             | Generations route through Activity/Runs.                                                 |
| BYOK scope?                                              | **Workspace.**                                                      | Org-level BYOK can be added later under `/:org/developer` or `/:org/security` if needed. |
| Workspace ACL editor read-write or read-only at launch?  | **Read-write.** Workspace Owners need to tighten.                   | Org `enforced` policies prevent expansion.                                               |

---

### 19. Naming locks

Words that appear in the product, locked:

| Concept                          | Word                                     | Never                                                            |
| -------------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| Top-level customer entity        | **Organization**                         | "Tenant", "Account", "Workspace" (workspace is the sub-unit)     |
| Sub-unit inside an org           | **Workspace**                            | "Project", "Team"                                                |
| Workspace roles                  | **Owner / Member / Viewer**              | "Operator", "Analyst", "Editor", "Contributor"                   |
| Org roles                        | **Owner / Admin / Compliance / Billing** | "Super Admin", "Root", "Manager", "Security Admin"               |
| Authentication identity          | **Principal**                            | "Account", "Identity", "User" (in role/grant contexts)           |
| Capability invocation unit       | **Capability**                           | "Permission", "Action", "Verb" (in nav text)                     |
| Cause of an automation run       | **Trigger**                              | "Automation", "Workflow", "Job"                                  |
| Reusable graph filter that fires | **Event**                                | "Signal", "Listener", "Subscription"                             |
| A unit of automated work         | **Run**                                  | "Job", "Task", "Execution" (was v1's term — dropped)             |
| What agents know                 | **Memories**                             | "Notes", "Knowledge items", "Facts" (fact is a _kind_ of memory) |

---

### 20. Document maintenance

When a decision in this document changes:

1. Update this file in the same PR as the implementation change.
2. Add a one-line entry to the bottom of this section with date + decision.
3. Update `docs/adr/` if the change overturns a previous ADR.

#### Changelog

- 2026-05-29 — Initial specification consolidated from product discussion.
- 2026-05-29 — Org roles cleaned up to single-word labels: `Owner / Admin / Compliance / Billing` (was `Owner / Admin / Security Admin`). Mirrors Google Workspace, Vercel, Linear, Notion conventions.
- 2026-05-29 — Production URL convention: until oxagen.ai launches, prod uses the vercel.app domains (`https://app.oxagen.sh`, `https://www.oxagen.sh`, `https://api.oxagen.sh`, `https://admin.oxagen.sh`). All URL values live in env vars; never hard-coded.
- 2026-05-29 — Google OAuth scope locked to `openid profile email`. The `hd` claim from the Google ID token is captured to `users.orgDomain` so the app can detect Google Workspace accounts and prefill organization name on signup.
- 2026-05-30 — Capability invocation boundary updated: `withCapabilityCheck` removed; enforcement is now structural via `defineContract()` + `contract.invoke()`. §9 and §12 updated accordingly. See `docs/architecture/iam/plan.md` for the full design.
- 2026-06-16 — Implementation realigned to this spec's workspace tree. The app had drifted: a standalone **Agents** sidebar item, a standalone **Subagent Runs** item, and a **Workflows** item (a banned term per §19) had appeared, and a half-finished `/agents` → `/automation/agents` migration created an infinite redirect loop (the Agents page "didn't work"). Fixes: agents now live only under **Automation → Agents** (`/automation/agents/*`); the subagent fan-out viewer and the former "Workflows" parallel-task executions are folded into **Activity → Runs** with filter chips by kind (§5), with chat/API/MCP runs surfaced as "coming soon" until `activity.runs.list` ships; 301 redirects added for `/agents`, `/agents/runs`, and `/workflows`. No decisions changed — this only conforms the implementation to the existing tree.

