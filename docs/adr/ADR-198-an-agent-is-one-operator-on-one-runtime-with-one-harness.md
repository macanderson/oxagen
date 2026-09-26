# ADR-198: An agent is one operator on one runtime with one harness

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** platform
- **Supersedes:** ADR-057 decision 1 (git is the definition of record) and the
  legacy `create/update/publish_agent_def` path it left in place.
- **Refines:** ADR-024 (the agent key and the 18-character agent slug),
  ADR-179 (a re-enrolled host carries on its predecessor's sessions).
- **Related:** issue #4369, issue #3852 (named toolbelts),
  `packages/database/atlas/migrations/20260926020000_runtimes_toolbelts_agent_versions.sql`,
  `packages/oxagen/src/workspace-slug.ts`,
  `packages/oxagen/src/contracts/{runtime,toolbelt,tool.state,agent.register,agent.move,agent.toolbelt.assign}*.ts`.

## Context

When you enroll a laptop today, Oxagen has no record of the laptop. The
Runtimes page's "Enroll a runtime" button opens the agent register wizard,
`tacho.hosts` holds a hostname, and nothing ties an agent to the machine it
runs on. The agent you register carries its own prompt, tool list, budget and
model tier in `.oxagen/agents/<slug>.toml`, a file proposed by pull request
and cached in `agent.agent_versions` (ADR-057 decision 1). A toolbelt exists
only as the list `get_agent_toolbelt` computes on each read (#3852).

That model makes an agent a piece of configuration. The IAM principal, its
roles and its mandates hang off something that is really a prompt, so
changing the prompt or the tool list means editing the thing permissions are
granted to. It also ties nothing to hardware, so moving an agent to a new
machine or a new cloud has no representation at all.

## Decision

### 1. An agent is one operator on one runtime with one harness

An agent is the IAM principal Oxagen assigns roles, mandates and budgets to.
It stands for one operator (the person it acts for,
`iam.principals.parent_user_id`) running one harness on one runtime. Your
laptop with Claude Code is one agent. The same laptop with Codex is a second.

- The principal, the operator and the harness never change for the life of
  the `agent.agents` row.
- `agent.agents.runtime_id` and `agent.agents.toolbelt_id` hold what the agent
  is bound to now.
- A partial unique index, `agents_runtime_harness_uniq`, allows one live
  agent per runtime and harness in a workspace. A retired (archived) or
  deleted agent frees the pair. The operator is not in the key: one runtime
  runs one agent per harness whoever operates it, which is what the register
  form enforces when it disables a taken pair.
- An agent carries no prompt, no instructions and no definition file. What it
  is told comes from steering (ADR-093, ADR-187). What it can reach comes from
  its toolbelt. What it may do comes from its roles and mandates.

### 2. A change of runtime or toolbelt is a new agent version

`agent.agent_versions` records what the agent was bound to from each version
on: `runtime_id`, `toolbelt_id` and `change_kind` (`registered`,
`runtime_changed`, `toolbelt_changed`, or `legacy` for rows written before
this ADR). `register_agent` writes version 1. `move_agent` and
`assign_agent_toolbelt` each write the next version and move the current
binding on the agent row in the same transaction. The principal does not
move, so its roles, mandates, credentials and runs survive a hardware
replacement or a cloud migration.

`move_agent` also revokes the agent's live host enrollments on the old
runtime, with the writes `revoke_tacho_enrollment` makes, because a live host
holds the agent key (`tacho_hosts_agent_key_uniq`) and the new machine cannot
enroll until it is released.

`agent_versions.config` stays. It holds the per-agent budget
(`budget.per_run_micros`, `budget.per_day_micros`) and `[containment]`
(ADR-152) the host bundle reads, and the in-app assistant's settings. A new
version copies the prior version's config forward.

### 3. A runtime is a named slot, not a machine

`agent.runtimes` holds a name and a slug per workspace. It holds no machine
facts. `tacho.hosts.runtime_id` binds a host enrollment to it: a token
enrollment takes the agent's runtime, and an operator enrollment finds or
creates the runtime its hostname names. When the machine is replaced, the new
host enrolls against the same runtime, and ADR-179 carries the sessions over.

The table is named for what the Runtimes page shows. It is not
`tacho_sessions.runtime` or `TACHO_RUNTIMES`, which name the harness a session
ran under.

Adding a runtime asks for a name and a slug, then goes straight to
registering its first agent, because a runtime with no agent governs nothing.

### 4. Toolbelts, and which tools a belt may hold

A toolbelt is the set of tools an agent is shown. It narrows what an agent
can reach and never widens a grant. #3852's rule stands: roles, mandates and
kill switches decide each call.

- An owner or admin decides, per tool, whether it is available to toolbelts
  (`agent.tools.enabled`) and whether it starts active in a belt
  (`agent.tools.default_active`), through `set_tool_state`, for a list of
  tools or every tool one server contributed.
- Every workspace has one All tools belt (`tools.toolbelts.kind =
  'all_tools'`). Its members are every available tool, each active as its
  default says. It stores no member rows and cannot be edited. The first
  toolbelt path to touch a workspace creates it, and the migration creates
  one for every existing workspace.
- `clone_toolbelt` copies a belt into a `custom` belt that stores its own
  members (`tools.toolbelt_tools`). `update_toolbelt` removes or adds a
  server, and turns a server or a single tool on or off in the belt.
- A tool that stops being available leaves every belt at resolution time. A
  belt keeps its row, so the tool returns as the belt left it.
- On a wrapped harness the host bundle enforces the belt: every imported MCP
  tool the agent's belt leaves out becomes a deny rule
  (`mcp__<server>__<tool>`) beside the RBAC rules. A server the operator
  configured on the machine and never imported is not the workspace's to
  narrow. Stella's in-app assistant runs on no runtime, and no belt narrows
  its tools. Roles, grants and kill switches still decide each of its calls.
- An agent registered with no toolbelt named carries the All tools belt.

#3852 proposed a `tools.toolbelt_assignments` table from an agent principal
to a belt. This ADR puts the belt on the agent row and on each version
instead, because a belt change has to write a version and an agent carries
one belt at a time. The assignment table would have been a second place the
same fact lived.

### 5. One slug rule

`slugFromName` (`packages/oxagen/src/workspace-slug.ts`) derives every slug
Oxagen makes from a name: organizations, workspaces, runtimes, agents and
toolbelts. It lowercases, keeps the base letter of an accented one, turns
each run of spaces and hyphens into one hyphen, and drops every other
character, apostrophes included. "Mac's Laptop" becomes `macs-laptop`. The
two copies in `apps/app` now call it. Agent slugs stay capped at 18
characters (ADR-024), and the derived slug is cut to fit.

### 6. The definition file goes

`.oxagen/agents/<slug>.toml`, `propose_agent`, `commit_agent_definition`, the
`revise/suggest/summarize` definition capabilities, the
`create/update/delete/publish/get/list_agent_def` family, `deploy_agent`, the
Definition tab, the source editor and the create-agent wizard are removed.
The migration copies each version's `[budget]` and `[containment]` tables
into `config`, the column the host bundle already fell back to, and then
drops the six cache columns (`definition_path`, `definition_digest`,
`definition_source`, `commit_sha`, `branch`, `pull_request_url`).

## Consequences

- Registering an agent takes a name, a harness, a runtime and a toolbelt.
  The register form shows a runtime that already runs the chosen harness,
  disabled, with a popover naming the agent that holds it, and does the same
  for a harness the chosen runtime already runs.
- When a workspace has no available tool, the register form's toolbelt step
  completes itself, stays visible, says why there is nothing to pick, and
  links to the page that imports MCP servers.
- One machine can now be the runtime of several agents, one per harness, but
  `tacho enroll` keeps one enrollment per machine (`host.json`) and
  re-enrolls to add a harness. Until tacho holds one enrollment per agent on
  a machine, a second agent on a runtime cannot enroll its host without
  revoking the first. That change is #4371.
- No surface edits a per-agent budget or `[containment]` after the Definition
  tab goes. The values the migration copied stay enforced. Editing them waits
  on a decision about where agent-scope limits live (#4372).
- Existing agents keep their principals. The backfill places each live agent
  on the runtime of its newest host. Where two live agents with one harness
  shared a hostname, the newer one keeps the runtime and the older one is left
  unplaced for its owner to move.

## Alternatives considered

- **Keep the file and add a runtime to it.** Rejected: the file makes the
  agent a piece of configuration, and a principal whose permissions follow a
  prompt cannot survive a prompt change without re-granting.
- **One agent per operator, with runtimes and harnesses as attributes.**
  Rejected: an operator runs several harnesses on several machines, and each
  needs its own credential, its own kill switch and its own mandate trail.
- **A new agent per machine.** Rejected: every hardware change would orphan
  the roles, mandates and run history the old principal held.
- **A toolbelt assignment table (#3852).** Rejected for the reason in
  decision 4.
