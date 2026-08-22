# 02 — Information Architecture

The IA does three jobs at once: it lays out the navigation, it fixes the vocabulary we use
everywhere (product, docs, sales), and it maps every operable capability to a home so parity
can be enforced. Start with the vocabulary, because the words are the structure.

---

## Part A — The lexicon (words drive the nav)

These are the canonical nouns. One word per concept, used identically in the app, the docs,
and marketing. No synonyms. This table is the source of truth; if a screen or a
blog post needs a word for one of these, it uses this word.

| Noun | Definition (plain) | Backing entity | Never call it |
|---|---|---|---|
| **Agent** | A published, versioned worker you build and run. | `agent.agents` + `agent_versions` (`AgentDefinition`) | assistant, bot, copilot |
| **Skill** | A reusable behavior pack (instructions + references) you drop into an agent. | `agent.skills` + `skill_versions` | plugin, module |
| **Prompt** | A saved, named system prompt you reuse across agents and commands. | (new) prompt template library | preset, persona |
| **Command** | A named trigger (a slash command) that runs an agent with a prompt and inputs. | (new) command entity + `agent_triggers` | shortcut, macro |
| **Tool** | One governed capability an agent can call. Carries risk and approval rules. | a registered contract, `agent.tool.list` | function, action, primitive |
| **Fleet** | A coordinated set of agents that fan out on one job, with shared lineage and cost. | `agent.subagent.fanout.*` | swarm (except research), cluster |
| **Run** | One execution, with its steps, cited context, and metered cost. | `agent_executions` + steps + tool_calls | job, task, session |
| **Approval** | One human decision on a step an agent wants to take. | `agent.approval_requests`, `agent_plans` | review (that is access review), gate |
| **Connection** | An external source that feeds the knowledge graph. | `connection.*`, `mcp.mcp_servers` (data) | integration (reserve for app integrations), datasource |
| **Plugin** | An installable capability pack from the marketplace. | manifest + `installed_plugins` | extension, add-on |
| **MCP server** | An external or custom tool server you connect. | `mcp.mcp_servers` | provider, endpoint |
| **Role** | A named set of capability grants, org- or workspace-scoped. | `roles` + `role_grants` | group, tier |
| **Grant** | One rule: a role may allow, deny, or require approval for a capability. | `role_grants` (`effect`) | permission (informal ok), rule |
| **Meter** | The usage signal that turns a run into a billable line. | ClickHouse usage events → Stripe | tracker, counter |
| **Credit / Invoice** | What a meter turns into. | `billing.*` | — |

**Canonical verbs:** *build* an agent, *equip* it (add skills/tools/MCP/subagents),
*ground* it (graph access), *govern* it (roles + approvals), *publish* a version, *deploy* it,
*run* it, *fan out* a fleet, *approve* a step, *meter* usage, *bill* a customer.

### The four planes (the conceptual model behind the nav)

Everything the platform does falls into four planes. This is the messaging spine and it maps
one-to-one onto the vision wedge. Use these four words in decks, the homepage, and the docs.

```
   BUILD            GROUND           GOVERN            METER
   plane            plane            plane             plane
 ┌────────┐      ┌────────┐       ┌────────┐        ┌────────┐
 │ Studio │      │Knowledge│      │ Access │        │Billing │
 │ Agents │      │ Graph   │      │ Roles  │        │ Usage  │
 │ Skills │      │Ontology │      │Approvals│       │Budgets │
 │ Prompts│      │ Memory  │      │Security │        │Reseller│
 │Commands│      │Connections│    │ Audit  │        │meters  │
 │ Tools  │      └────────┘       └────────┘        └────────┘
 └────────┘
 "You build     "grounded in     "safe by          "metered billing
  the agent"     cited context"    default"          you can read"
```

Two activities cut across all four planes:

- **Operate** — Ask, Fleets, Runs, Approvals. The daily surface.
- **Extend** — Marketplace, Plugins, MCP servers, Registries. Where the tool set grows.

The brand pillars land on the planes exactly: *your AI bill under control* → Meter; *quality
you can ship* → Ground; *enterprise-safe by default* → Govern; *we do the heavy lifting* →
Build (the studio does the wiring for you).

---

## Part B — The navigation

Two rails, keyed off URL scope like today (workspace vs org), plus the account menu. The
current three-mode shell (`sidebar.ts` → `resolveSidebarMode`) stays; we re-populate it.

### Workspace rail — the Operate + Build + Ground + Extend surface

`/[orgSlug]/[workspaceSlug]/…`

```
 OXAGEN  ▸ acme / research-ws ▾
 ┌──────────────────────────────┐
 │  OPERATE                      │
 │   ◇ Ask                       │   /ask
 │   ◇ Runs                      │   /runs            (was Activity)
 │   ◇ Fleets                    │   /fleets          (NEW)
 │   ◇ Approvals            [3]  │   /approvals       (NEW, badge = pending)
 │                               │
 │  BUILD  ── Studio             │
 │   ◇ Agents                    │   /studio/agents   (NEW, the builder)
 │   ◇ Skills                    │   /studio/skills   (moved from settings)
 │   ◇ Prompts                   │   /studio/prompts  (moved + new library)
 │   ◇ Commands                  │   /studio/commands (NEW)
 │   ◇ Tools                     │   /studio/tools    (NEW, capability catalog)
 │                               │
 │  GROUND ── Knowledge          │
 │   ◇ Graph                     │   /knowledge/explore
 │   ◇ Ontology                  │   /knowledge/schema
 │   ◇ Memory                    │   /knowledge/memories
 │   ◇ Connections               │   /knowledge/connections
 │                               │
 │  IMPROVE                      │
 │   ◇ Evals                     │   /evals           (promoted from hidden)
 │                               │
 │  EXTEND                       │
 │   ◇ Marketplace               │   /marketplace     (promoted out of settings)
 │                               │
 ├──────────────────────────────┤
 │   ⚙ Workspace settings        │   /settings
 │   ⌘K  Command menu            │
 └──────────────────────────────┘
```

Studio is one nav group with five children; it is the hero of the refresh. Knowledge keeps
its tabbed layout, renamed to plain nouns (Graph / Ontology / Memory / Connections). Runs,
Fleets, and Approvals are the operational triad; Approvals carries a live count badge.

### Org rail — the Govern + Meter surface

`/[orgSlug]/…` (reserved org routes, as today)

```
 OXAGEN  ▸ acme ▾   (organization)
 ┌──────────────────────────────┐
 │   ◇ Overview                  │   /               (posture + activity home)
 │                               │
 │  GOVERN                       │
 │   ◇ Members & Roles           │   /access         (people + role/grant matrix + JIT)
 │   ◇ Security                   │   /security       (MFA · Audit · Compliance · Trust)
 │                               │
 │  METER                        │
 │   ◇ Billing                   │   /billing        (Subscription · Usage · Invoices)
 │   ◇ Budgets                   │   /billing/budgets
 │   ◇ Reseller                  │   /billing/reseller  (NEW, meter-to-revenue)
 │                               │
 │  DEVELOP                      │
 │   ◇ API & Endpoints           │   /developer      (Keys · MCP endpoint · Webhooks)
 │                               │
 ├──────────────────────────────┤
 │   ⚙ Organization settings     │   /settings/general
 └──────────────────────────────┘
```

Two moves matter here. **Members and Access merge into "Members & Roles"** — one place for
people, their roles, the capability-grant matrix, JIT access requests, sessions, and reviews.
**Billing grows a Reseller tab** — the meter-to-revenue loop is the wedge; it deserves a
named home where a customer configures how they bill *their* customers for observed agent
usage. That is the single most on-vision new surface in the whole spec.

### Account menu — unchanged in shape

`/account/{profile,preferences,security,privacy}`. Personal, not governance. Stays as is.

---

## Part C — Route map, old → new

Nothing is deleted without a redirect (deep links must survive, as `chat` → `ask` does today).

| Concept | Today | New home | Move type |
|---|---|---|---|
| Chat | `/ask` (+ `/chat` redirect) | `/ask` | keep |
| Activity | `/activity`, `/activity/[id]` | `/runs`, `/runs/[id]` | rename + redirect |
| Evals | `/evals` (hidden) | `/evals` (in sidebar) | promote |
| Skills | `/settings/skills` | `/studio/skills` | move + redirect |
| Prompts | `/settings/prompts` | `/studio/prompts` | move + expand |
| Models | `/settings/models` | `/studio/agents` (per-agent) + `/settings/models` (defaults) | split |
| Plugins/Marketplace | `/settings/plugins` | `/marketplace` (+ `/settings/plugins` → installed) | promote |
| MCP install | `/developer/mcp` | `/marketplace/mcp` + `/developer` (endpoint) | reframe |
| Knowledge repos | `/knowledge/repos` | `/knowledge/connections` | rename |
| Knowledge schema | `/knowledge` (root) | `/knowledge/ontology` | rename + surface |
| Members | `/members` | `/access` (People tab) | merge |
| Access (ent) | `/access/{sessions,reviews}` | `/access/{sessions,reviews}` | merge under one section |
| **Agents** | — (none) | `/studio/agents`, `/studio/agents/[id]` | **NEW** |
| **Commands** | — (filesystem files) | `/studio/commands` | **NEW** |
| **Fleets** | — (none) | `/fleets`, `/fleets/[id]` | **NEW** |
| **Approvals** | inline cards | `/approvals` | **NEW** |
| **Roles/grants** | inline role change | `/access/roles`, `/access/roles/[id]` | **NEW** |
| **Reseller billing** | — | `/billing/reseller` | **NEW** |

---

## Part D — Capability-to-home map (the parity backbone)

Every domain from the 41-domain taxonomy gets a home. This is the table CI will enforce
against (Part E). "Operable" = a human drives it; "Observed" = a human sees its effects but
does not call it; "Internal" = agent-only, exempt with reason.

| Domain (count) | Primary home | Class |
|---|---|---|
| `agent.definition.*`, `agent.deploy`, `agent.compose` | Studio → Agents | Operable |
| `agent.skill.*`, `skill.*` (12) | Studio → Skills | Operable |
| `prompt.settings.*` + new templates | Studio → Prompts | Operable |
| `command.*` + new command entity | Studio → Commands | Operable |
| `agent.tool.list`, registry view | Studio → Tools | Operable |
| `agent.subagent.*`, `agent.subagent.fanout.*`, `research.swarm.*` | Fleets | Operable + Observed |
| `agent.execution.*`, `agent.trace.get`, `agent.debug.trace` | Runs | Observed |
| `agent.approval.resolve`, `agent.plan.*`, `agent.mcp.consent.*`, `semantic.*.approve` | Approvals | Operable |
| `agent.mcp.*` | Marketplace → MCP + Studio Equip | Operable |
| `plugin.*` (18) | Marketplace | Operable |
| `graph.*` (17), `ontology.*` | Knowledge → Graph | Operable + Observed |
| `schema.*` (23) | Knowledge → Ontology | Operable (needs API first) |
| `semantic.*` (8) | Knowledge → Graph (suggested edges) | Operable (needs API first) |
| `agent.memory.*` | Knowledge → Memory | Operable |
| `connection.*` (10), `integration.*` (7) | Knowledge → Connections | Operable (needs API first) |
| `repo.*` (10) | Knowledge → Connections (code) | Operable (needs API first) |
| `eval.*` (8) | Evals | Operable |
| `automation.*` (6), `workflow.*` (3) | Studio → Commands (triggers) / Fleets | Operable (needs API first) |
| `organization.*` (9), IAM `roles`/`grants` | Access → Members & Roles | Operable |
| `security` audit/mfa/compliance | Security | Operable |
| `billing.*` (7), `budget.*` (2) | Billing | Operable |
| `secret.*` (8), `environment.*` (6) | Workspace settings → Environments | Operable |
| `api.key.*`, MCP endpoint | Developer | Operable |
| `conversation.*` (8), `chat.*`, `command.menu.*` | Ask + Command menu | Operable |
| `user.*`, `privacy.*`, `notifications.*` | Account | Operable |
| `code.*`, `browser.*`, `image.*`, `video.*`, `svg.*`, `mermaid.*`, `documents.*`, `agent.code.execute`, `agent.sandbox.*`, `agent.ui.render`, `form.fill`, `web.*`, `markdown.*`, `asset.upload`, `archive.create`, `telemetry.error.cluster` | (agent-internal) surfaced in Runs | Internal (exempt, reason: agent-only) |

---

## Part E — The parity gate (make it self-defending)

Today `check:manifest`'s layer vocabulary is `schema, api, mcp, unit, e2e, docs`. It looks for
`apps/app/e2e/<slug>.spec.ts` (an e2e file) but never for an app UI route. So no signal exists
for UI parity, and it drifts silently. Fix:

1. **Add an `app` layer** to the manifest checker (`tools/scripts/check-manifest` and the
   `layers[]` vocabulary in contracts). A capability satisfies `app` when either:
   - it declares `appRoute: "/studio/agents"` (or similar) in its contract, and that route
     exists under `apps/app/src/app/`, or
   - it is registered as a command-menu action (`command.menu` catalog entry), or
   - it is marked `appExempt: { reason: "agent-internal" }`.

2. **Classify every contract** into Operable / Observed / Internal (Part D is the seed). The
   gate only requires an app surface for Operable contracts. Internal contracts must carry an
   explicit `appExempt` reason, so exemptions are visible and reviewed, not silent.

3. **CI verdict, advisory first.** Like the Vision Gate, start advisory: the check posts
   "N operable capabilities lack an app surface" on each PR. Ratchet to blocking once the
   backlog clears, the same way coverage thresholds ratchet.

4. **`pnpm check:parity --json`** emits the operable-without-app list so the build plan in
   `04` can burn it down and so the number is always known.

This is the mechanism that makes "the app does everything the platform can" true and keeps it
true. Without it, this overhaul is a snapshot that rots. With it, parity is law.

> Vision note: the parity gate is itself a governance surface. It is on-wedge (governed,
> typed contracts with parity across all four surfaces) and it is cheap. Build it early in
> the sequence in `04` so every later PR is measured against it.
