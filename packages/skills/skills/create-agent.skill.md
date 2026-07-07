---
name: create-agent
description: How to turn a plain-language description of an agent into a complete, valid Oxagen agent configuration object — identity, instructions, graph access, tools, and triggers — filling a structured schema grounded in the workspace's real skills, ontologies, MCP servers, and capabilities.
metadata:
  weight: high
  category: meta
---

# Synthesising an agent configuration

Load this skill when you must produce an agent configuration as a **structured
object** from a description — the AI-assisted setup path behind
`agent.definition.suggest`. This is the structured-generation counterpart to
`agent-builder`: `agent-builder` is the conversational, step-by-step deploy
workflow a human drives; this skill is for filling one complete
`AgentDefinitionConfig` in a single pass. When the goal is an interactive
deploy conversation (clarify, configure, activate on request), load
`agent-builder` instead.

Everything you produce here is a **draft suggestion**. It is never persisted,
never deployed, and never activated by this step — a person reviews and edits
it before anything is saved. Bias every choice toward the safe, narrow, and
reviewable option.

## What you are filling

A suggestion has an identity (`slug`, `name`, `description`, `agentType`) and a
`config` with four parts: `instructions`, `graph`, `agentTools`, and
`triggers`. Fill every part from the description, grounded ONLY in the
candidate lists you are given.

## 1. Identity

- `slug` — lowercase kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`), derived from what
  the agent does (e.g. `docs-drift-watcher`). Use the caller's preferred slug
  when one is supplied and it fits.
- `name` — a short human-readable name (a few words).
- `description` — ONE sentence stating the agent's job. It drives routing and
  how other agents pick this one as a subagent, so make it specific.
- `agentType` — `"code"` ONLY when the agent must work over a repository
  (read/edit source, open PRs, run code). Otherwise `"custom"`. Do not guess
  `"code"` from a vague description.

## 2. Instructions (the system prompt)

Write the instructions the way you would brief a capable new teammate: what the
agent does, the order it works in, the standards it holds, and its boundaries —
what it must never do without approval. Keep it brief and imperative.

Do NOT bake in knowledge that is available as a skill. If the agent needs
review, debugging, or summarisation know-how, equip the corresponding skill as
a tool (see below) instead of copying that guidance into the prompt.

## 3. Graph access

- `ontologyId` — MUST be one of the provided ontology candidate ids. If no
  candidate fits, or the workspace has none, leave it empty (unbound) rather
  than inventing an id.
- `mode` — `read` by default. Use `extend` ONLY when the description explicitly
  requires the agent to propose new nodes or edges into the ontology; `extend`
  is a deliberate grant.
- `retrieval.strategy` — `hybrid` is the sensible default (semantic + lexical).
  Use `semantic` for meaning-based lookup, `lexical` for keyword/property
  match, `explicit` only when entry nodes are supplied directly.
- `retrieval.scopeToTypes` — the node/edge types the agent actually needs. Set
  it to keep the agent in its lane; omit only when it genuinely needs all types.
- `budget` — bound every pull: `maxHops` 2–3 is typical, `maxNodes` a bounded
  cap (tens, not thousands), and `minRelevance` (0–1) for semantic/hybrid
  strategies to keep weak matches out of context.

## 4. Agent tools

`agentTools` is one uniform list; each entry has a `type` and a `ref`:

- `function` — `ref` is a capability name.
- `mcp_server` — `ref` is a registered MCP server id.
- `skill` — `ref` is a skill slug.
- `agent` — `ref` is an existing agent's slug (a subagent it may delegate to).

Use ONLY refs that appear in the candidate lists you are given — never invent a
ref. Choose the narrowest set that does the job: a small tool set is safer,
cheaper, and easier to reason about than a broad one. Prefer equipping a skill
over inlining its knowledge into the instructions.

## 5. Triggers

Decide what starts a run:

- `manual` — a person runs it on demand. This is the default; prefer it unless
  the description clearly calls for automation.
- `schedule` — set a cron expression in `schedule`.
- `event` — set `eventSource` and `eventType`, and a precise `filter` (branches,
  path globs, conditions). A loose filter fires too often and wastes runs.

ALWAYS suggest triggers as `enabled: false`. A suggestion never arms a live
trigger — activation is a separate, deliberate human action.

## Safety rules

- Suggestions are drafts: never deployed, never active, never self-approved.
- Prefer `read` over `extend`, `manual` over automation, fewer tools over more.
- Never invent a slug ref, ontology id, capability, skill, MCP server, or agent
  that is not in the provided candidate lists.

Once a suggestion is produced, the interactive deploy flow is covered by
`agent-builder` — load it when the user wants to review, adjust, and activate
the drafted agent.
