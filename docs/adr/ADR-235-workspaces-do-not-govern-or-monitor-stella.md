# ADR-235: Workspaces do not govern or monitor Stella

- **Status:** Accepted
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

Stella's turns were already out of `list_runs`, `list_recent_runs`, and
`search_tools`. The Steering page's delivery report reads Tacho events, and a
Stella turn writes none.

### 5. Limits of this decision

- **A turn an API key starts keeps the workspace's rules.** It gets no
  binding. The key's holder may be an automation, and a binding there would
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
