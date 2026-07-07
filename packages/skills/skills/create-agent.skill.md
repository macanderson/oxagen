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
candidate lists you are given. You may also return `recommendations` — tools the
agent should have but that are not available yet (see section 6). Everything the
agent equips (`agentTools`) must exist now; everything it merely needs (but the
workspace lacks) goes in `recommendations`.

## 1. Identity

- `slug` — lowercase kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`), derived from what
  the agent does (e.g. `docs-drift-watcher`). Use the caller's preferred slug
  when one is supplied and it fits. **Keep it to 18 characters or fewer.** An
  agent is addressed by a global key `org_ns.workspace_ns.slug` that must never
  exceed 32 characters, so the slug is capped at 18 to leave room for the
  org+workspace namespaces. A longer slug is truncated for you, but a tight,
  meaningful slug (`schema-audit`, not `schema-addition-auditor-for-prs`) reads
  better after truncation.
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

## 6. Recommendations — connect first, equip later

There are **two tiers** of capability, and they must never be mixed:

- **Equip what exists.** `agentTools` may ONLY reference things that are
  available in the workspace right now — the equipable candidate lists
  (functions, enabled skills, registered MCP servers, active agents). Never put
  anything else there.
- **Recommend what should be connected.** When the description clearly needs a
  tool the workspace does **not** have yet, return it in `recommendations`
  instead. The two connectable sources are given to you under **CONNECTABLE**:
  - **Catalog MCP servers** — servers in the synced registry that are not
    registered in this workspace. Use `kind: "mcp_server"` and set `ref` to the
    registry name shown (e.g. `github/github-mcp-server`).
  - **Disabled workspace skills** — skills that exist but are turned off. Use
    `kind: "skill"` and set `ref` to the slug shown; the caller enables it before
    equipping.

Every recommendation needs a `reason` written **against the user's description** —
say what the agent does that requires it (e.g. "watches PRs for schema changes,
so it needs GitHub access"). Recommend only what the job genuinely needs; do not
pad the list. Anything already available belongs in `agentTools`, not here.

### Worked example

> "Build an agent that audits schema additions in my source code — watch PRs for
> schema changes and validate the schema doesn't already exist by checking my
> Supabase databases."

The workspace has **no** GitHub MCP server and **no** Supabase MCP server
registered, but both appear under CONNECTABLE (catalog MCP servers). The right
suggestion is:

- `slug`: `schema-audit` (≤ 18 chars).
- `agentTools`: only what exists now — e.g. a graph `function` capability and any
  enabled review skill. **No** GitHub or Supabase refs, because they are not
  registered yet.
- `recommendations`:
  - `{ kind: "mcp_server", ref: "github/github-mcp-server", name: "GitHub",
    reason: "watches PRs for schema changes — needs to read diffs and repo files" }`
  - `{ kind: "mcp_server", ref: "supabase/supabase-mcp", name: "Supabase",
    reason: "validates a new schema doesn't already exist by inspecting the
    Supabase databases" }`
- `triggers`: one `event` trigger on repo pull requests, suggested
  `enabled: false`.

The caller connects GitHub and Supabase, then equips them in a follow-up edit.

## Safety rules

- Suggestions are drafts: never deployed, never active, never self-approved.
- Prefer `read` over `extend`, `manual` over automation, fewer tools over more.
- Never invent a slug ref, ontology id, capability, skill, MCP server, or agent
  that is not in the provided candidate lists.
- Never equip a recommendation. `agentTools` only holds equipable candidates;
  connectable catalog servers and disabled skills go in `recommendations`, each
  with a `ref` copied exactly from the CONNECTABLE lists.
- Keep the slug ≤ 18 characters (the global agent key must stay ≤ 32).

Once a suggestion is produced, the interactive deploy flow is covered by
`agent-builder` — load it when the user wants to review, adjust, and activate
the drafted agent.
