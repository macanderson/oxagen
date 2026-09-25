# ADR-187: Two gateways carry every customer agent's traffic, and Oxagen holds the keys

- **Status:** Proposed
- **Date:** 2026-09-25
- **Owners:** platform, gateway
- **Decided by:** the maintainer set the direction on 2026-09-25. This record awaits acceptance
- **Related:** ADR-094 (the gateway on the laptop), ADR-143 (credential custody on the laptop), ADR-122 (external tools need a person), ADR-078 (one tool builder), ADR-056 and ADR-163 (run commands), ADR-095 (the tier ladder), ADR-096 and ADR-152 (the contained tier), ADR-165 (the governed action is billed), #3299, #4310
- **Detail:** `docs/gateway-plan.md` in `macanderson/oxagen-roadmap` holds the waste reason codes, the per-harness setup, and the build order

## Terms

This record uses two names and no others:

- **Local gateway.** The process on the machine the agent runs on. Today this is the model proxy inside `tachod`.
- **Cloud gateway.** The service that holds the keys and governs every call. Oxagen hosts it by default, and a customer may host it in its own network.

## Path

Every model call goes through both, in order:

```
agent ──> local gateway ──> cloud gateway ──> model provider
          screens for         holds the keys, applies policy,
          sensitive data:     budgets, and operator commands,
          reject or strip     meters, and records
```

MCP calls take the same path to the MCP server. Operators reach every agent through the cloud gateway, whatever runtime the agent runs on.

## Context

Checked at `main` `22902576f`.

Oxagen is the control plane an enterprise buys for its agents: one place to route and govern agent traffic, as Kong does for APIs, with an audit trail fit for SOC 2, full spend management with an account of wasted spend, and verification that a run did what it was asked. On `main`:

- The local gateway meters model calls, enforces budgets, and aborts calls on pause, cancel, and kill (`packages/tacho/src/collector/model-proxy.ts`). The vendor key sits in `credentials.json` on the same machine (ADR-143), so the machine's owner can go around it.
- The local gateway already ships each request and response to Oxagen as the body of its `llm_call` frame (`model-proxy.ts:10-15`), and a workspace with no retention policy stores them in full (`packages/handlers/src/lib/tacho-host.ts:262-264`).
- The workspace toolbelt reaches only the in-app agent (`packages/agent/src/runtime/materialize-tools.ts:991-1009`). No customer agent receives it.
- Nothing screens a prompt for sensitive data before it reaches a model provider.

## Decision

### Local gateway

The local gateway stays on every enrolled machine. It screens each outbound request for sensitive data (passwords, keys, classified material, and whatever else the workspace defines) and either rejects the request or strips the sensitive data out before forwarding it. The detection design is open, and a language model running on the machine is one candidate.

A model request carries the whole conversation: the prompt, the files the agent read, and every tool result. So screening the request screens everything the provider would see. Data the local gateway strips never reaches Oxagen or the model provider. Responses pass through unscreened.

The local gateway also runs the hooks, which gate the harness's own tools (Bash, Edit, Write) that never cross the network, and it fetches the run token the harness presents.

### Cloud gateway

The cloud gateway has three entry points: model APIs (Anthropic, OpenAI, Gemini, Bedrock, streamed), MCP (one endpoint per server in the workspace toolbelt), and HTTP egress for other outbound calls. Every request passes the same steps:

1. **Identify.** The run token names the agent, the run, its task, its parent run, and the person it acts for.
2. **Check the run.** A paused or cancelled run, or a spent budget, is refused.
3. **Apply policy.** Allow, deny, send to a person for approval, or narrow the input.
4. **Reserve budget.** Hold the call's largest possible cost against the run, agent, team, and organization budgets, so parallel calls cannot overrun.
5. **Add context.** Add the context records chosen for this agent and turn, and any queued operator steer, and record what was added.
6. **Forward.** Attach the credential from the vault and route the call.
7. **Meter.** Count usage as the response streams, and cut the stream on command.
8. **Settle.** Price the actual usage and release the rest of the reservation.
9. **Record.** Write one signed event to the run's record.

### Keys and runs

- Oxagen holds the vendor keys and MCP credentials in a vault. On a customer-hosted cloud gateway they stay in the customer's KMS. No agent holds a real credential.
- The harness holds a run token for one agent, one machine, and one run. A token is short-lived. A run is not: the local gateway refreshes the token for as long as the run lasts, which can be days.
- The cloud gateway checks the run on every call, so a cancelled run is stopped whatever its token's expiry, and it has no key to fall back on.

### Operator control

An operator signs in to Oxagen and acts on the agents they control, whatever runtime each runs on. They select one agent, several, or all of them, and send one command. Oxagen sends it to every live run of those agents and reports, per run, what happened and which record entry proves it.

| Command | What the cloud gateway does |
|---|---|
| Steer | Adds the text to the run's next model request, at the delivery mode the operator chose (`turn_boundary`, `next_step`, or `interrupt`, ADR-056) |
| Interrupt | Aborts the run's model call in flight and delivers the steer on the harness's retry |
| Pause | Aborts the call in flight and refuses the run's new calls until resume |
| Resume | Accepts the run's calls again |
| Cancel | Aborts the call in flight, revokes the run token, refuses every later call, and seals the run as cancelled |

The hooks carry the same commands to the harness's own tools: they refuse the next tool call and prompt of a paused or cancelled run. For an agent whose model calls do not pass through the cloud gateway, the hooks are the only way in: a steer lands at the next hook, an interrupt becomes a refusal of the next tool call, and pause and cancel refuse the next tool call and prompt.

Commands reach a run at every tier (ADR-163). Who may command which agents, and who may command all of them at once, follows the grants in `mission-control-spec.md` §7.6 in `macanderson/oxagen-roadmap`.

### Context records

"Context record" stays the name. A context record has a kind, and the kinds include skills, business rules, code rules, style preferences, facts, and memories, alongside the kinds in use today. There is no separate agent persona. A team authors context records in Oxagen. The cloud gateway adds the ones that fit each turn, and a harness that reads files (skills, rules) receives them through a pull request to the repository, as context records land today.

### Retention

The workspace chooses what Oxagen stores, as it does today: digests only (`digest_only`), or everything, prompts and responses included. The cloud gateway changes when a body crosses to Oxagen, during the call instead of after it. The local gateway's screen changes what crosses at all.

### Audit

Each event is appended to its run's hash chain and signed by the gateway that saw it. A daily root of every chain goes to write-once storage, so any later edit shows. Every change in the control plane (policy, key, budget, toolbelt, role) is an event with its actor. An export maps the record to SOC 2 controls: who could call what, every call and refusal, and every policy change with its approver.

### Spend and verification

- The cloud gateway prices each call from the provider's own usage figures and attributes it to the organization, team, agent, run, task, and parent run.
- Waste is spend with a reason code (failed outcome, errors and retries, cache misses, loops, reverted work, oversized model). `gateway-plan.md` defines each.
- A run is bound to a task whose checks are written and locked before it starts (`dod-spec.md` in `macanderson/oxagen-roadmap`). The agent can claim done. A verifier outside its reach runs the checks and signs the verdict. The headline figure is cost per verified outcome.

### Live run view

An operator signs in to Oxagen, opens a run that is still going, and sees it update as it runs:

| What the page shows | Where it comes from |
|---|---|
| Spend so far, as an estimate before the run ends | The cloud gateway's settled cost plus the calls in flight, priced from the tokens streamed so far. It becomes final when each call settles |
| Tool calls, counted by tool name | The run's record: the hooks' tool frames and the cloud gateway's MCP calls |
| The diff of the files changed, shown the way GitHub shows a pull request | The local gateway captures the working tree's diff after each file edit and at the end of the run |
| The pull request and its CI status | The work record, below |
| Steer, interrupt, pause, resume, and cancel | The operator control above, on this run or on every run selected |

The page reads the run's record as it is written, so nothing waits for the run to seal.

### Work orders

An operator selects one or more work items (issues and tasks), chooses **Send To...**, and picks the harness, the runtime, and the toolbelt the work runs with, or an existing agent that fixes all three. Oxagen creates a work order and launches the agent to do the work, with no step on the operator's machine.

- **The work order stays.** It carries the work items, the definition of done, the brief, the repositories the run may change, and the spend cap, as `work-backlog.md` and `work-in-flight-spec.md` §9 in `macanderson/oxagen-roadmap` already design. What this adds is the harness, runtime, and toolbelt choice, and the automatic launch.
- **The launch goes to the chosen runtime.** An enrolled machine's local gateway starts the harness headless. A contained runner starts it on a CI runner (ADR-152). A customer-hosted runner starts it in the customer's network. Oxagen starts a process the customer chose and runs no turn itself (ADR-043, ADR-096).
- **The run is bound to its work order.** Its record carries the work order, so the live run view, the work record, and verification all read from it.

### Work record

Every run records where its work happened and what it produced: the repository by name, the branch, the local directory, the files it changed, its pull request, the CI status on that pull request, and the issues, tasks, and work orders it relates to. Each change lands on the run's record, so the audit trail holds it.

On `main`, `get_run_work` (`packages/oxagen/src/contracts/run.work.get.ts`) already returns most of this. The gaps:

| What | On `main` | Gap |
|---|---|---|
| Repository | Named when the workspace has connected it. Otherwise the session stores only a digest of the remote URL (`git_remote_digest`) | The name, for every repository |
| Branch and directory | Recorded: `git_branch`, `cwd`, `project_dir`, and the worktree | None |
| Files changed | The diff between the run's start and end commits, where the workspace retains it | #4309 fixes the count |
| Pull request | Found by a recorded link, the head commit, or the branch, and read from GitHub when someone opens the run | Recorded on the run as it opens and changes |
| CI status | Read from GitHub when someone opens the run | Recorded on the run as it changes. The GitHub webhook route has no `pull_request` handler today |
| Issues and tasks | The issues the pull request closes, read from GitHub | The issue, task, or work order the run started from (ADR-162, not built), and trackers beyond GitHub |

### Agents on other runtimes

Every agent connects to the cloud gateway, so agents message and start one another through it (`send_agent_message`, `list_agent_messages`, `start_agent_run`). A message follows `mission-control-spec.md` §7.6. A start creates a work order on the target agent's own runtime, and the child runs under its own mandate.

### Deployment

- The cloud gateway runs in regions Oxagen chooses. A customer may run the same image in its own network, where it dials out to Oxagen, keeps keys in the customer's KMS, and keeps bodies inside that network.
- It keeps serving from its last signed configuration while Oxagen's control plane is unreachable.
- The local gateway runs on every enrolled machine, and in a contained runtime inside the sandbox.

### Coverage limits

- **Claude Code on the web** has no local gateway. Its model calls go from Anthropic's infrastructure to Anthropic with the user's subscription. Its MCP calls can reach the cloud gateway through the repository's `.mcp.json`, unscreened.
- **Tools a vendor runs** (claude.ai connectors, Codex apps, Cursor Cloud Agents) never pass either gateway.
- **Subscription logins** cannot be held by Oxagen, so the kill switch does not bind a run on one.
- Everything the local gateway does not strip passes through Oxagen's cloud gateway, unless the customer hosts it.

## Proposals

These are design choices this record makes. Each needs the maintainer's yes before it is built:

1. The cloud gateway is the meter of record. The metering and budget code in `model-proxy.ts` moves there.
2. Screening is a workspace setting: off, flag, strip, or reject.
3. The local gateway signs each request it forwards with its scan verdict. A workspace can require that signature, and the cloud gateway then refuses a request that skipped the screen.
4. MCP calls go through the local gateway too, since an MCP server is a third party. HTTP egress passes the local gateway only where `HTTPS_PROXY` is set or in a contained runtime.
5. Each MCP server keeps its own endpoint and its registered name, so the harnesses' per-server rules keep working.
6. Enrollment imports each harness's existing MCP servers into the toolbelt and moves their credentials into custody.
7. Codex, which reads a fixed key, gets a token that lasts its whole run.
8. On managed devices, Oxagen turns off the tools a vendor runs.
9. One encryption key per organization in the vault.
10. Starting another agent needs a grant naming both agents.
11. Pull request and CI changes arrive by GitHub webhook and are appended to the run's record.
12. A send that picks a harness, runtime, and toolbelt creates a new version of an agent for that combination, so every run still belongs to one agent with one runtime.

## Consequences

- **Memories become a kind of context record.** They live today in Neo4j as `AgentMemory` (`packages/agent/src/memory/neo4j.ts:135`), separate from context records.
- **Skills become a kind of context record.** They live today in `.oxagen/skills/<name>/SKILL.md`, written by `propose_skill`, separate from context records.
- **The renames and personas in flight stop.** The rename to "steering records" (#4325) and agent personas (#4326) do not happen.
- **Keys leave the machine.** `credentials.json` goes away for any harness whose calls route through the cloud gateway. One platform variable encrypts every workspace's MCP credentials today (`packages/plugins/src/credentials/kms.ts:4-5`).
- **The toolbelt reaches customer agents.** The in-app agent leaves it (#4310).
- **Tier evidence.** A call the cloud gateway carried is the control plane's own evidence for the `gateway` tier.

## Supersedes and amends

- **ADR-094, in part.** The local gateway stays and gains the screen. It no longer holds the key or makes the last hop. Bodies cross to Oxagen during the call, where under `content_exact` they already cross after it.
- **ADR-143, in part.** Vendor keys move from the machine to the vault or the customer's KMS. The run token stays.
- **ADR-122:19.** An agent's own identity may hold a grant for an external tool.
- **ADR-078 §4 stays.** There is one tool builder, and it runs on the server.

## Alternatives considered

**The local gateway alone (ADR-094).** Rejected. The machine's owner can go around it and take the key, so no operator command is certain to land, and the machine cannot serve the toolbelt without its credentials.

**The cloud gateway alone.** Rejected. Sensitive data would reach Oxagen and the model provider unscreened.

**A customer-hosted cloud gateway only.** Rejected as the default. A team without a network to run it in could not start.

## Open for acceptance

1. The sensitive-data detection design.
2. The twelve proposals above.
3. How a Codex whole-run token is revoked when the harness restarts.
4. The first regions for the Oxagen-hosted cloud gateway.
