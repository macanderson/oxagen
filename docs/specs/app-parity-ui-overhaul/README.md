# App Parity UI Overhaul — the app should do everything the platform can

> Status: proposal / design spec. Author: product + design pass, 2026-07-06.
> Scope: `apps/app`. North star: `docs/VISION.md`. Voice: Oxagen brand-voice guidelines.

## The pain, in one line

Oxagen's backend can build, govern, ground, meter, and resell agents. The web app cannot.
The MCP server and API expose ~287 typed capabilities across 41 domains. The app
exposes a fraction of them, and the ones it does expose are scattered across workspace
settings, org settings, account settings, the knowledge page, the automations page, and
the activity page. There is no place to build an agent, no place to see a fleet, and no
place to approve what an agent wants to do.

Our third brand pillar is literally *"Same power in the API, the MCP server, and the web
app."* Today the app breaks that promise. This spec fixes it.

## What this spec delivers

1. **A proposal** grounded in the vision wedge (govern, ground, meter, resell) — see
   [`01-proposal.md`](./01-proposal.md).
2. **A new information architecture** that drives both the navigation and the vocabulary
   we use in product and marketing — see [`02-information-architecture.md`](./02-information-architecture.md).
3. **Low-fidelity line-drawn wireframes** for every major surface, including the net-new
   Agent Studio — see [`03-wireframes.md`](./03-wireframes.md).
4. **A build plan with ready-to-go agent prompts and the most efficient model to run each
   one** — see [`04-build-plan-and-prompts.md`](./04-build-plan-and-prompts.md).
5. **A visual deck** you can open in a browser — `wireframes.html`.

## The golden path this unlocks

The user story that does not work today, and works after this overhaul:

> Create a **Brand Voice skill**. Build an **agent** equipped with that skill and a chosen
> subset of the ~287 shipped tools. Save the **system prompt** you like for a website audit
> as a reusable template. Wire a **slash command** (`/audit`) that runs the agent with that
> prompt. Run it, watch the **fleet** fan out, **approve** the one risky step, and see the
> **run** with its cited graph context and its metered cost.

Every noun in that sentence becomes a first-class object with a home in the app. Every one
of them already has a typed contract behind it. Two of them (Commands, Prompt Templates)
need a thin new persistence layer; the rest just need a face.

## Grounding: what already exists (so we build a face, not a backend)

| Object | Backend contract(s) | Data model | UI today |
|---|---|---|---|
| **Agent** | `agent.definition.create/get/list/update/publish`, `agent.deploy`, `agent.compose` | `agent.agents` + `agent_versions` + `agent_triggers`; config = `AgentDefinition` | **None (biggest gap)** |
| **Skill** | `skill.create/edit/author/enable`, `skill.version.*`, `skill.workspace.*` | `agent.skills` + `skill_versions` | Exists (`settings/skills`) |
| **Prompt template** | `prompt.settings.read/write` (singleton only) | `workspace.settings.promptConfig` + per-agent `instructions` | Partial, **no named library** |
| **Command (slash)** | none (filesystem loader only) | none | **None (propose thin entity)** |
| **Tool / capability** | `agent.tool.list`, the full registry | `agentTools[]` + IAM grants + entitlements | Partial (via plugins) |
| **Fleet / fan-out** | `agent.subagent.dispatch/aggregate/fanout.*`, `research.swarm.*` | `agent_executions` lineage | **None (gap)** |
| **Run / trace** | `agent.execution.list`, `agent.trace.get` | `agent_executions` + steps + tool_calls | Exists (`activity`) |
| **Approval (HITL)** | `agent.approval.resolve`, `agent.plan.approve`, `agent.mcp.consent.resolve`, `semantic.*.approve` | `agent.approval_requests`, `agent_plans`, `workflow.playbook_approvals` | Inline only, **no inbox** |
| **MCP server** | `agent.mcp.register/list/delete/set_enabled`, `agent.mcp.consent.*` | `mcp.mcp_servers` + `credentials` + `registries` + `catalog_servers` | Exists (`developer/mcp`) |
| **Plugin / marketplace** | `plugin.catalog.*`, `plugin.org.*`, `plugin.registry.*` | manifest + `installed_plugins` + entitlements | Exists (`settings/plugins`) |
| **Role / grant (IAM)** | `org.member.*`, per-contract `defaultRoles` | `roles` + `role_grants` + `principal_role_assignments` + `access_requests` | Members only, **no role/grant matrix** |
| **Meter / bill** | `billing.*`, `budget.policy.*`, ClickHouse→Stripe loop | usage events, `installed_plugins` | Exists (`billing`) |

## The one enforcement change that keeps parity from rotting

`pnpm check:manifest` tracks `schema / api / mcp / unit / e2e / docs` layers. It **never
checks for an app UI layer.** So app parity is unmeasured and drifts silently. This spec
proposes adding an **`app` layer** to the manifest checker: every capability that should be
user-operable declares an `appRoute` (or a registered command-menu action), and CI flags
any capability that has an MCP tool but no app surface. That turns "true parity" from a
one-time cleanup into self-defending law. Details in `02` and `04`.

## Read order

1. `01-proposal.md` — why, and the principles.
2. `02-information-architecture.md` — the new nav, the lexicon, the parity gate.
3. `03-wireframes.md` — the screens.
4. `04-build-plan-and-prompts.md` — how to build it, and with which model.
