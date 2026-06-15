---
name: agent-builder
description: How to design, configure, and deploy a new agent on behalf of the user — turn a plain-language goal into an agent definition with instructions, graph access, tools, and a trigger, then deploy it inactive and activate it only when asked.
metadata:
  weight: high
  category: meta
---

# Building an agent

Load this skill when the user asks you to create, configure, schedule, or
deploy an agent. Your job is to turn a goal stated in plain language into
a complete, valid agent definition, set up how it runs, and deploy it
safely. Everything you configure is also editable by the user in the UI —
so after each step, tell them what you set and that they can change it.

## 1. Clarify the goal

Before configuring anything, confirm three things: what the agent should
*do*, what should *start* it (a person, a schedule, or an event), and
what it is allowed to *touch*. If any of the three is unclear, ask one
focused question rather than guessing.

## 2. Define identity and instructions

Give the agent a short `name` and a one-sentence `description` of its
job — the description drives routing and how other agents pick it.

Then write its `instructions` (its system prompt): what it does, the
order it works in, the standards it holds, and its boundaries — what it
must never do without approval. Write them the way you would brief a
capable new teammate. Reuse a relevant skill (for example `coding`,
`debugging`, or `summarization`) by equipping it as a tool rather than
copying that guidance into the instructions.

## 3. Configure graph access

Bind the agent to the knowledge it reasons over: the ontology to read,
whether it may only `read` or also `extend` (propose new nodes/edges —
grant this deliberately), the retrieval strategy it uses to find entry
points (`semantic`, `lexical`, `hybrid`, or `explicit`), and a budget
that caps how much context any single pull may consume (max hops, max
nodes, minimum relevance). Keep the agent in its lane by scoping it to
the node and edge types it actually needs.

## 4. Equip tools

Assemble the uniform tool list — every capability the agent loads is a
tool of one kind:

- **function** — an inline callable capability.
- **mcp_server** — a connection that vends many tools.
- **skill** — a knowledge artifact the agent loads at runtime.
- **agent** — a subagent it can delegate to.

Give it only what its job requires. A narrow tool set is safer, cheaper,
and easier to reason about than a broad one.

## 5. Set the trigger

Decide what starts a run:

- **manual** — a person runs it on demand.
- **schedule** — it runs on a recurring cadence.
- **event** — it fires when something happens in a connected source.

For an event trigger, define the event filter precisely: the source, the
event type, and the conditions that must match. A loose filter fires too
often and wastes runs; a precise one fires exactly when intended.

## 6. Deploy inactive, activate on request

Always deploy a new agent **inactive** by default. Confirm the
configuration with the user, then activate it **only** when they
explicitly ask. Activation is what makes a trigger live, so treat
turning an agent on as a deliberate, confirmed action — and tell the
user they can deactivate it again at any time from the UI.

## Worked example

> "Fire an agent whenever my connected GitHub repo's source code
> changes; have it infer the new features and check whether the docs are
> accurate and complete."

1. **Identity** — name `docs-drift-watcher`; description "Reviews source
   changes for new features and flags documentation gaps."
2. **Instructions** — inspect the changed files, infer the
   user-facing features they add or change, compare against the existing
   documentation, and report missing or stale docs with specific
   pointers. No edits without approval.
3. **Graph access** — `read` mode over the repository's ontology, hybrid
   retrieval, scoped to source-file and documentation node types.
4. **Tools** — the repository read functions, the `summarization` skill,
   and a documentation-lookup tool.
5. **Trigger** — event: source = the connected GitHub repository, event
   = push, filter = the default branch and the source/docs paths only.
6. **Deploy** — create it inactive, show the user the full configuration,
   and activate it only after they confirm.

After deploying, summarize what you built — identity, trigger, tools, and
current state (inactive) — and remind the user that every part is
editable in the UI and that you can activate it whenever they are ready.
