---
# Agents

- **Route:** `/{orgSlug}/{workspaceSlug}/workbench/agents`
- **Nav location:** workspace → Workbench → tab "Agents"
- **Priority:** P1
- **Disposition vs today:** Keep

## Purpose
The catalog of every agent definition owned by the workspace — draft, published, and deployed — and the entry point into building, editing, and launching them. This is the build-side counterpart to Ask: Ask runs agents, Workbench/Agents designs and ships them, including the definitions a team ultimately resells.

## Primary user & jobs-to-be-done
- **Primary user:** agent builder / workspace admin
- **JTBD:**
  - See at a glance which agents are draft vs published vs deployed, and which version is live
  - Open an existing agent to edit its prompt, equipped tools, and bindings
  - Create a new agent definition from scratch
  - Deploy a published agent version so it becomes launchable from Ask
  - Understand who can manage (edit/deploy/publish) vs merely view an agent

## Functionality
- Table/grid of agent rows: name, status badge (Draft / Published), deployment badge (Deployed / Not deployed), active version.
- Row click → Agent Builder in edit mode (`workbench/agents/[agentId]`).
- Deployed rows expose a "Launch" action → `/{orgSlug}/{workspaceSlug}/ask?agent={agentId}`, binding the agent to a fresh conversation.
- "New agent" button, visible only when `canManage` is true for the acting user.
- Empty state distinct from zero-results-after-filter (if search/filter added later).

## Capabilities invoked
- `agent.definition.list` (`list_agent_defs`) — populate the table.
- `agent.definition.get` (`get_agent_def`) — row detail on navigation.
- `agent.definition.create` (`create_agent_def`) — New agent flow.
- `agent.definition.update` (`update_agent_def`) — status transitions surfaced from the builder.
- `agent.deploy` (`deploy_agent`) — deployment badge state.
- `agent.definition.publish` (`publish_agent_def`) — published badge state.

## Data sources
Postgres (agent_definitions, versions, deployment records) via the capabilities above.

## States
- **Empty:** no agents yet — prominent "Create your first agent" CTA (manager-gated).
- **Loading:** table skeleton rows while `list_agent_defs` resolves.
- **Error:** inline retry banner if the list call fails; New agent stays available if only the list failed.

## Existing implementation
- **Today:** `workbench/agents/page.tsx` is COMPLETE — status/deployment/version badges, row-to-builder navigation, deployed-agent Launch link, and manager-gated New button all wired.

## Vision alignment
Agents are the unit teams build and resell — this list is where governed, versioned, publishable agent definitions become discoverable and launchable, directly serving the "Stripe for agents" wedge.
