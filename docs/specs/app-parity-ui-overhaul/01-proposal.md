# 01 — Proposal

## The problem, stated plainly

You can do more from a terminal than from the product you pay for. That is backwards.

Oxagen ships ~287 governed capabilities. A developer with the API or the MCP server can
create an agent, equip it with skills and a chosen subset of tools, wire triggers, run a
fleet, and read the metered cost. A buyer sitting in the web app can do almost none of
that. The app today is a chat window with a knowledge graph bolted on and a pile of
settings pages. The most valuable thing the platform does, letting a team build, govern,
and resell agents, has no home on screen.

Worse, the pieces that *do* exist are scattered by accident of history, not by design:

- **Agents** have no page at all. You configure their behavior in three different settings
  tabs (prompts, models, budget) and watch them run in a fourth (activity).
- **Skills** live under Workspace Settings.
- **System prompts** are a read-only box plus a per-capability override form, also under
  Workspace Settings. There is no way to save the prompt you like and reuse it.
- **Slash commands** do not exist in the app. They are markdown files read off the filesystem.
- **MCP servers** install under Org → Developer. **Plugins** install under Workspace →
  Settings. They are the same idea (extend the agent) in two different places.
- **Fleets** and **approvals** have no page. A risky step shows up as an inline card in the
  chat stream and vanishes when you scroll.
- **Roles and permissions** stop at "change this member's role." There is no way to see or
  edit which of the 287 capabilities a role can call, even though the backend maps every
  one.

A buyer evaluating Oxagen against a competitor opens the app, cannot find where to build an
agent, and concludes the platform is a chat toy. The backend is enterprise infrastructure.
The frontend hides it.

## Why this is a vision problem, not a polish problem

`docs/VISION.md` names the wedge Oxagen wins: the metered, governed, graph-grounded control
plane for teams that build and resell AI agents. Three of the five drift tests the Vision
Gate asks are about surfaces this overhaul creates or fixes:

- *"Does this help a team that builds and resells AI agents meter, govern, ground, or bill
  their product?"* The app is where that team lives. A team cannot govern what it cannot
  see. Today the app shows them almost none of the governance, grounding, or metering the
  backend performs.
- *"Does it add a capability without a typed contract, IAM gate, or metering?"* No. Every
  surface in this spec binds to an existing typed contract with its IAM and metering
  already attached. We are adding faces, not ungoverned paths.
- *"Does it present agent output without citations where graph grounding applies?"* The new
  Run and Ask surfaces make citation first-class, not incidental.

Capability parity across API, MCP, and UI is not a nice-to-have. It is pillar three of
our own positioning and one of the four moats. The UI is the leg of that promise we are not
keeping. This overhaul is how we keep it.

## What "true parity" means here

Parity does not mean a form for all 287 contracts. Many contracts are agent-internal
plumbing (`agent.code.execute`, `agent.ui.render`, `svg.generate`) that a human never calls
by hand. Parity means:

**Every capability a human would operate has a home in the app, and CI can prove it.**

We split the 287 into three buckets:

1. **Operable surfaces** (build an agent, install a plugin, resolve an approval, edit a
   role, read a run). These get first-class UI. This is the bulk of the work.
2. **Agent-internal capabilities** (the model calls them, humans do not). These need no
   human UI, but their *effects* must be observable in Runs and their *governance* editable
   in Roles. They are marked exempt from the app-layer gate with a reason.
3. **API-gap capabilities** (64 contracts with no `/v1` route yet: schema, connection,
   integration, repo, semantic, workflow). The app cannot wire to a capability that has no
   API. These are sequenced *before* their UI, per the contract → API → MCP → UI law in
   `CLAUDE.md`.

## Design principles

1. **Objects, not pages.** The app is organized around the nouns a builder thinks in
   (Agent, Skill, Prompt, Command, Tool, Fleet, Run, Approval, Connection, Plugin, Role),
   not around the settings tabs that happened to accrete. Each noun has one home. See the
   lexicon in `02`.

2. **One way to equip.** Because `AgentDefinition.agentTools[]` loads skills, MCP servers,
   tools, and subagents through one uniform shape, the app has one Equip picker that spans
   all four. A user never learns four different "add a capability" flows.

3. **Governance is visible, not buried.** Every capability carries `riskLevel`,
   `requiresApproval`, and `defaultRoles`. The UI shows those inline, everywhere a tool
   appears. Building an agent and governing it are the same screen, not different teams.

4. **Grounding is the proof.** Agent output cites nodes and edges by human label, never raw
   UUID (per `CLAUDE.md` citation rules). Runs show the graph context that grounded each
   answer. This is the accuracy moat made visible.

5. **Cost is always in frame.** Every run, fleet, and agent shows its metered cost. This is
   the meter-to-revenue wedge made visible, and the reseller's daily reason to log in.

6. **Parity is enforced, not promised.** The `app` layer in `check:manifest` fails CI when
   an operable capability has no app surface. Parity that is not measured will drift; we
   measure it.

7. **Plain words win.** Following the brand voice: an Agent is an agent, not an "assistant."
   A Tool is a tool, not a "capability primitive." A Run is a run. The lexicon in `02` is
   the single source of truth for these words, and product copy, docs, and marketing all
   draw from it.

## Non-goals

- This is not a visual restyle. Component system stays `@oxagen/ui` / coss-ui. The change is
  structural (IA, new surfaces), not cosmetic.
- We do not build a second chat transport. Ask stays on the existing SSE path
  (`use-tool-stream.ts`).
- We do not fight on connector breadth, standalone evals, or framework mindshare (vision
  guardrail). Evals get a proper home because it already exists and is hidden, not because
  we are investing in evals as a front line.

## Outcome

After this overhaul, a buyer opens the app and finds, in order: a place to **ask**, a
**studio** to build agents, a view of their **fleets** and **runs**, an **approvals** inbox,
the **knowledge** that grounds it all, a **marketplace** to extend it, and clear
**governance** and **billing**. The app finally looks like what the backend already is:
infrastructure for building, governing, grounding, and reselling agents.
