---
# Tools

- **Route:** `/{orgSlug}/{workspaceSlug}/workbench/tools`
- **Nav location:** workspace → Workbench → tab "Tools" → sub-tab "All Tools"
- **Priority:** P2
- **Disposition vs today:** Keep

## Purpose
A read-only catalog of every tool an agent can be equipped with in this workspace — built-in tools plus installed skills — so builders can browse and inspect capabilities before wiring them into an agent in the Agent Builder. Management (install/uninstall/enable) lives on the sibling Skills / MCP Servers / Capabilities tabs; this page is discovery and inspection only.

## Primary user & jobs-to-be-done
- **Primary user:** agent builder
- **JTBD:**
  - Browse all tools available to equip, across sources
  - Search and filter by category/source to find a specific tool fast
  - Inspect a tool's schema, description, and source before equipping it
  - Understand which sub-tab (Skills / MCP Servers / Capabilities) manages a given tool's lifecycle

## Functionality
- Search bar (name/description match) and filter chips (by source: built-in / skill / MCP / capability pack).
- Grid or list of tool cards: name, one-line description, source badge, category tag.
- Row/card click opens a detail sheet: full description, input/output schema, source link (which sub-tab manages it).
- Sub-tab bar at top: All Tools (this page) · Skills · MCP Servers · Capabilities.

## Capabilities invoked
- `agent.tool.list` (`list_agent_tools`) — populate the catalog.
- `agent.skill.list` (`list_agent_skills`) — include installed skills in the catalog.

## Data sources
Postgres-backed tool/skill registry, read via the capabilities above.

## States
- **Empty:** no tools installed yet — CTA pointing to Skills / MCP Servers / Capabilities to install one.
- **Loading:** card grid skeleton while `list_agent_tools` / `list_agent_skills` resolve.
- **Error:** inline retry banner; search/filter stay interactive against last-good data.

## Existing implementation
- **Today:** `workbench/tools/page.tsx` is COMPLETE — search/filter and detail sheet both wired; management correctly deferred to sibling tabs.

## Vision alignment
Every tool here is a typed, governed contract, not an arbitrary function call — this catalog is where that governance becomes visible to the person deciding what to equip, reinforcing the anti-poisoning trust posture. P2: valuable discovery surface, not blocking core flows.
