# ADR-235: Workspaces do not govern or monitor Stella

- **Status:** Accepted. Amended 2026-10-01 with the maintainer's ruling on
  every limit §5 listed, and on the Stella CLI. Amended 2026-10-02 with the
  maintainer's ruling on the assistant's spend and on controls.
- **Date:** 2026-09-30
- **Owners:** platform
- **Decided by:** the maintainer, 2026-09-30, answering #4310: "the in app
  agent stella does not get governed or monitored by workspaces they are
  separate and not under customer control."
- **Related:** issue #4310, PR #4859 (Batch D1, which shipped the opposite
  default), #4226 (a rule's park and resume, superseded here), #3303 and
  #4158 (workspace steering in Stella's prompt, reversed here), ADR-053 §1
  (amended), ADR-093 §7 (amended), `packages/oxagen/src/oxagen-assistant.ts`,
  `packages/oxagen/src/kernel.ts` (the decision-rules gate),
  `packages/agent/src/runtime/assistant-turn.ts`,
  `packages/agent/src/runtime/approval-resume.ts`.

> **Amended 2026-10-01 and 2026-10-02.** The maintainer ruled on the
> thirteen open items this ADR first left for him, on the Stella CLI, and then
> on the assistant's spend and on controls. The amendments at the end state
> each ruling and what the code does under it. Where they and §5 disagree, the
> amendments hold.

## Context

Stella is Oxagen's in-app agent. A person asks it about their workspace, and
it acts through Oxagen's capability contracts as that person (ADR-053 §1).
The customer talks to it and does not own it.

Until this ADR, the customer's workspace shaped Stella in four ways:

- The kernel's decision-rules gate judged every Stella tool call, as it judges
  an API call. A workspace rule could refuse the call or send it to a person,
  and #4226 parked such a call on the turn's card.
- The workspace's published context records and its configured instructions
  went into Stella's system prompt, ranked by the steering assembler (#3303,
  #4158, ADR-093 §7).
- Every Stella turn counted as a run of the workspace's managed `qa-chat`
  agent on the Agents page.
- Every Stella tool call wrote a `tool_invocations` row, which the
  workspace's tool registry counts as "calls 30d".

Batch D1 (#4859) already took the workspace's MCP servers off Stella's tool
belt (`capabilitiesOnly`). It kept the rules gate on Stella's calls and asked
the maintainer whether to skip it. D1's argument for keeping it: a person
could then do through Stella what a workspace rule stops them doing through
the API. The maintainer answered that Stella is separate from the workspace
and not under customer control, and that answer covers that case.

## Decision

### 1. A kernel-minted binding marks a call as Stella's

`CapabilityContext.oxagenAssistant` carries an `OxagenAssistantBinding`.
`createOxagenAssistantBinding` in `packages/oxagen/src/oxagen-assistant.ts`
mints it and records the object in a module-private `WeakSet`, the pattern
the platform-operator and deployed-agent bindings use.

- **Two producers.** The assistant turn mints one in `prepareAssistantTurn`,
  and the resume of a call a Stella turn parked mints one in
  `resumeApprovedCall`. An arch test,
  `packages/oxagen/src/test/oxagen-assistant-field.test.ts`, fails when any
  other file outside `packages/oxagen` names the minting function.
- **A claimed binding is refused.** The kernel treats any value the registry
  does not hold as a forged binding. A literal, a spread copy, and a JSON
  round trip of a minted binding each fail the invocation with `authz_denied`
  and a security event. The API and MCP context builders put no such key on a
  context, whatever the request sends.
- **A customer's agent never counts.** The kernel ignores the binding on a
  context that also carries `agentRun` or `deployedAgentInvocation`. A
  handler that builds a customer agent's context by spreading Stella's gets a
  context the workspace still governs.
- **It rides nested calls.** The kernel spreads the context into the handler's
  checked context, so a call a Stella call's handler makes carries the same
  binding.

The binding lives on the context, not on `InvokeOptions`. An option does not
reach a nested invoke, so a Stella call whose handler invokes another
capability would meet the workspace's rules one level down.

### 2. What a Stella call skips

- **The workspace's decision-rules gate.** The kernel does not call it for a
  call that carries the binding, and `requireFreshRules` does not refuse one
  for want of a gate. So no rule refuses, parks, or auto-approves a Stella
  call, and no auto-approval receipt is written for one.
- **The rule-park path from #4226.** `materializeTools` no longer turns a
  rule's approval into a parked card, and the resume no longer passes
  `requireFreshRules` or a rule digest. A resume payload sealed with a rule
  digest before this ADR resumes like any other.
- **Workspace steering.** The turn reads neither the workspace's published
  records nor its `additionalInstructions`. The system prompt is Oxagen's
  baseline alone. The run still records a `steering.manifest` frame, and the
  frame names no item.
- **Workspace MCP servers**, as Batch D1 already shipped.

### 3. What still binds a Stella call

- **The person's own IAM check.** Stella acts for the person who asked, and
  the kernel's IAM check still resolves that person. Without it, a person
  could use Stella to do what their role forbids. That check is access
  control, not workspace governance.
- **Billing and spend.** The credit gate, the billing admission gate, the
  budget gate, the entitlement gate, and the usage recorder all run as
  before.
- **The contract's own approval flag.** A contract that declares
  `agent.requiresApproval` is Oxagen's metadata, so its write still parks for
  the person.
- **Oxagen's own record.** The run ledger, the security event for each
  invocation, and the IAM audit row are Oxagen's record of what happened.

### 4. What Stella no longer feeds

- **The Agents page run counts.** `runFiguresByAgent` leaves out runs on the
  `chat` and `api-chat` surfaces, the same runs `list_runs` already leaves
  out.
- **The workspace's tool call counts.** A Stella call writes no
  `tool_invocations` row. That table's one reader is the registry's
  "calls 30d" count, and a row there cannot be told apart later, because its
  `surface` holds the transport and its `message_id` the person's message.
  The turn turns the write off with `feedsWorkspaceToolCounts: false`, not
  with the binding, so a turn an API key starts stays out of the count too.

Stella's turns were already out of `list_runs`, `list_recent_runs`, and
`search_tools`. The Steering page's delivery report reads Tacho events, and a
Stella turn writes none.

### 5. Limits of this decision

- **A turn an API key starts keeps the workspace's rules.** It gets no
  binding. It still feeds none of the monitoring §4 lists. The key's holder may be an automation, and a binding there would
  let it route an action a rule refuses on the API through Stella instead.
  Such a turn's writes already cannot park.
- **The `ask_assistant` call itself still meets the rules gate.** The API
  route, the SSE route, and the MCP tool invoke `ask_assistant` with the
  adapter's context, before the turn mints its binding. So a workspace rule
  written against `ask_assistant` still refuses the whole turn.
- **Kill switches still reach Stella.** An `agent` switch on the workspace's
  assistant agent stops the turn, and a workspace or organisation switch
  still cuts its tools. Org Owners and Admins set these.
- **Some records serve both Oxagen and the customer.** The Run page, the
  execution record, the audit log, approvals and their notifications, memory
  reinforcement on recall, run enrichment, and the per-turn workspace budget
  still see or shape Stella's turns.

Each limit waits on a choice the maintainer has not made. The PR that ships
this ADR lists each one under "For Mac" with its file and line.

## Alternatives

**Keep the rules gate on Stella's calls (Batch D1's default).** Rejected by
the maintainer's answer on #4310.

**Skip the gate for every call on the `agent` surface.** Rejected. A
customer's own agents call on that surface too, through `governed-turn`, so a
surface check would take the rules off the agents the workspace does govern.

**A boolean flag on `InvokeOptions` or on the context.** Rejected. A boolean
proves nothing about who set it, and an option does not reach a nested
invoke. The binding is minted in one module, checked by membership, and
pinned to two producers by a test.

## Consequences

- A person working in the app can have Stella take an action a workspace rule
  refuses on the API. The person's own role still bounds it. This is the
  trade-off D1 named, and the maintainer accepted it.
- ADR-053 §1 gains one clause: a Stella tool call skips the workspace's
  decision rules. ADR-093 §7's 2026-09-25 amendment no longer describes the
  in-app turn, which reads no workspace steering.
- `update_prompt_settings` still stores `additionalInstructions`, and nothing
  on Stella's path reads them now.
- `createApprovalRequest` still accepts `ruleIds` and `ruleDigest`, and no
  production caller passes them now. Rows parked before this ADR keep theirs,
  and `list_approvals` still shows the rule that parked them.

## Amendment of 2026-10-01: the full ruling

### The ruling

The maintainer ruled on 2026-10-01, in two halves.

- **Oxagen's in-app assistant.** Customers must never be able to configure
  governance or budgets against the assistant, from any entry point: the web
  app, an API key, or MCP. The assistant feeds no workspace monitoring.
- **The Stella CLI.** The open-source Stella coding agent a customer runs as a
  CLI to build their own product is a customer agent. It registers and is
  governed exactly like Claude Code and Codex.

The two share a name, so nothing in the exemption keys on the word "stella".
It keys on the kernel-minted binding, on the `inAppAssistant` contract flag,
and on the in-app run surfaces `chat` and `api-chat`. Tests pin both halves:
`src/test/oxagen-assistant-field.test.ts` prints the exemption code without
comments and finds no "stella" in it, and the tacho policy, host bundle, run
list, and runtime tests give the Stella CLI the same answers as Claude Code and
Codex.

### What each item does now

1. **Every turn carries the binding.** A turn an API key starts gets one too.
   `assistantBindingFor` mints it for every adapter.
2. **The assistant's own contracts skip the rules on every surface.** A
   contract declares `inAppAssistant: true`, and the kernel skips the
   decision-rules gate for it whatever the caller carries. That covers the
   call that starts a turn, which an adapter makes before the turn mints a
   binding. An arch test pins the sixteen contracts that carry the flag: the
   `assistant.*` contracts and the conversations the assistant keeps.
3. **Customer kill switches do not reach the assistant.** A Stella call
   answers only to a switch on the assistant's own agent
   (`assistantOwnSwitches`, used by the per-call gate and the belt).
   `set_kill_switch` refuses to turn a switch on or off against the managed
   assistant agent. Oxagen's own switch is the platform-only
   `set_assistant_switch`, run from `pnpm assistant:switch`. It writes the same
   `agent` deny row, and `readAssistantAgentState` enforces it. No such switch
   existed before. This ADR chose that shape under SCR-002: it reuses the
   switch row the turn already reads, and the platform-operator binding
   (INV-31) keeps it out of every customer surface. A switch a customer turned
   on before this amendment still stops the assistant until Oxagen turns it
   off with `set_assistant_switch`, which clears every `agent` switch on the
   assistant agent.
4. **Parked approvals reach only the person who asked.** An approval whose run
   is on an in-app surface stays off Fleet, the nav count, and approver
   notifications. Only the person who asked can answer it, and anyone else
   gets the answer for an unknown id. A person's approval
   of a Stella row never opens a workspace rule's standing window for a
   customer agent's identical call.
5. **The assistant's runs stay off workspace lists.** A single-run read of an
   in-app run answers as not found for anyone but the person who asked.
6. **Run enrichment skips assistant runs.** The sweep leaves out the in-app
   surfaces, so no paid summary is made for a Stella turn.
7. **The execution record stays internal.** Workspace-facing execution reads
   leave out the assistant's executions. A call carrying the binding reads
   only those of the person it acts for, so the assistant reads that person's
   history and no one else's.
8. **The security event stays, tagged.** Each security event of a Stella call
   carries `detail.oxagenAssistant: true`. The event is the person's own action
   on customer data and the SOC 2 record of it.
9. **No workspace memory.** The turn injects no recalled memory, and a recall
   the assistant makes reinforces and cites nothing.
10. **No customer-configured budget.** The turn reads neither the person's turn
    budget nor the workspace's, the kernel skips the customer's spend ceilings
    for a Stella call and for the assistant's own contracts on every surface,
    and the approval resume no longer checks them. The
    credit gate, the assistant spend cap, the billing admission gate, and
    invoice billing are Oxagen's and still apply. The SSE route accepts a
    `budget` field and ignores it.
11. **The titler uses Oxagen's prompt only.** The workspace's
    `conversation.title` override and its instructions no longer reach it.
12. **The assistant keeps its own retention policy.** Its
    `retention_policy_versions` rows carry `subject = 'oxagen_assistant'`, and
    every workspace reader reads `subject = 'workspace'` alone.
13. **The assistant is not listed as the customer's agent.** The Agents list,
    its tiles, `get_agent`, `search_tools`, and the command menu leave out the
    managed assistant agent and its `oxagen.assistant` principal. Assigning a
    role or granting a mandate to it is refused.

### What stays as accounting

The assistant's platform-paid tokens still land in `billing.spend_counters`,
so they count toward the customer's spend ceilings for the customer's own
agents. That is accounting of what the organisation spent, not a budget
against the assistant. It is listed for the maintainer in the PR that ships
this amendment.

## Amendment of 2026-10-02: spend and controls

### The ruling

The maintainer ruled on 2026-10-02, in two parts.

1. **The assistant's spend is its own line on the Spend page.** The totals
   include it, so they still match the daily rows and the statements. The
   line names no run and offers no drill-down, findings, or model analysis.
2. **The Oxagen app never controls the assistant.** No customer role gets a
   budget, cap, toggle, switch, setting, or approval control for the
   assistant, on any app page or through any API. Oxagen's own operator
   switch, `set_assistant_switch`, is platform-only and stays.

### What the code does

- **Spend.** `get_spend` returns one row keyed `ASSISTANT_SPEND_KEY` in every
  grouping when the period has an assistant run. The customer rows leave the
  assistant's share out, so the rows still sum to the total. The row lists no
  runs, and the page renders it with no link. `spend.drill` on a customer key
  leaves the assistant's runs out. The waste list names none of them, run
  names come back for none of them, and the cost rollup asks for no findings
  pass or Model fit reading for them. The findings pass reads no assistant
  run.
- **Controls.** `set_kill_switch` refuses the managed assistant agent, on and
  off, for every customer role (`kill_switch.set.ts`), and so do
  `agent.suspend` and `agent.retire`. The PR that ships this amendment lists
  every other control it found and what it did with each.
- **Per-turn budgets.** `get_user_budget`, `update_user_budget`,
  `get_budget_policy`, and `update_budget_policy` are deleted with the storage
  they wrote (ADR-277, #5102).

