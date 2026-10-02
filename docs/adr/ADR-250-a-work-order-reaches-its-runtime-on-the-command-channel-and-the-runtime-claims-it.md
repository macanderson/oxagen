# ADR-250: A work order reaches its runtime on the command channel, and the runtime claims it

- **Status:** Accepted
- **Date:** 2026-10-02
- **Owners:** work
- **Related:** issue #5100 (lane P1-04), `agent-work-phase-1.html` in
  `oxageninc/roadmap` (Work lifecycle, Data contract, Delivery and review),
  ADR-043 and its ADR-096 amendment, ADR-162, ADR-198, ADR-244, migration
  `20261002081300_work_order_delivery.sql`,
  `packages/handlers/src/lib/work-records/`.

## Context

ADR-244 stores a work item's life as facts, and its store opens a work order
when a person sends an approved brief. Nothing delivered that order to the
agent's runtime, linked the run that did the work, read the pull request's
checks, or recorded a person's acceptance. The phase spec asks for one complete
path: a person sends the brief to one agent, the runtime claims it before any
run starts, the result is reviewed on the pull request's exact head commit, and
a person accepts it. A retry must never start a second run.

Three things already work and are reused:

- `tacho.control_commands` carries commands to an enrolled host on its command
  poll (`fetch_commands`), at least once, with a 60-second redelivery lease and
  acknowledgements that only move forward.
- A run's pull request links (`run/pull-request.linked`) and the GitHub App's
  verified `pull_request` webhook.
- `dispatch_command`'s `cancel` stops a live run at its next boundary.

Oxagen does not run agents (ADR-043). It may contain the process that does
(ADR-096), but that launcher is not what a Phase 1 send uses.

## Decision

### Delivery

A send is one `work_order` row in `tacho.control_commands`, addressed to the
enrolled host of the target agent on the agent's runtime (`target_kind` host).
It carries the order's public id, its key, and the work item's id, never the
brief: the host reads the brief by claiming the order. The row takes the
order's idempotency key, `<item>:r<brief revision>:s<send>`, in a new
`idempotency_key` column with a unique index per workspace. The send runs under
the work item's row lock, so a retry with the same key finds the order and the
command it wrote and returns them. The runtime is offered one command for one
send.

`tachoCommandSchema` is an enum. A host built before `work_order` fails its
whole command poll and ingest response on one row it cannot name, and stops
receiving `pause` and `cancel` too. So the drain hands a `work_order` row only
to a host that advertises the `work_orders` bundle feature
(`BUNDLE_FEATURE_WORK_ORDERS`), and a send to a host that does not is refused
with "Update oxagen on that machine". The host side advertises the feature in
the change that handles the command.

### Claim

The host claims the order with `claim_work_order`, using its host key, before
any run starts. The claim is the handshake:

- The order's `work_order` command must have been addressed to this host, on
  the order's runtime. The command row names the host, so a second machine
  enrolled on the same runtime is refused.
- One host holds a send. The store keeps one `claimed` fact per order, and the
  claim is read back under the row lock, so a second claimant is refused.
- A host that claims again after a lost answer gets the same claim and the same
  first prompt back, and nothing new is recorded. Once a run is linked, a
  repeat claim is refused: the first answer was not lost, and a run already
  started.
- A send that ended (withdrawn, stopped, returned, or rejected) refuses the
  claim, so the host does not start it.

The claim's answer is the run's first prompt: the approved brief, then the work
item's text inside a code fence no line of it can close, labelled as data from
the issue. A host that cannot start the order refuses it with
`reject_work_order` and a reason. A host that could not even keep the order
acknowledges its command `failed`, and the send ends as rejected with the
host's reason, rather than waiting for a claim that cannot come.

### Starting the run

The runtime starts the run, not Oxagen. The host keeps a work order it
receives and logs the command to run. The person at the host runs
`oxagen work list` and `oxagen work start <wo>`, which claims the order and
starts the agent's harness in the current directory with the first prompt and
`OXAGEN_WORK_ORDER_ID` in its environment. Every refusal prints the server's
message and starts nothing. This is the delivery tasks-spec §9.6 describes,
and it is not a runtime under ADR-043: Oxagen hands the operator's brief to the
operator's own runtime and records what happens.

The run names its work order on its frames (`oxagen.work_order.id`, the
attribute F13's rollup already reads). Ingest links a new root run to the order
only when the run's host is the host that claimed it, and the first run to link
wins. A name alone links nothing, because any process on the host could write
it. A second run that names the same send, or a run that names a send that
already ended, gets a `cancel` when it links, so one send runs once.

### Results

- A run's seal (`cost/run.sealed`) records `run_ended` on the send it is linked
  to.
- A pull request the run names is recorded on the send (`pr_linked`) only when
  it is in the brief's repository. Oxagen then reads its head commit, the checks
  its base branch requires, and each check's conclusion from GitHub.
- The `pull_request` webhook records a new head, a human merge with its merge
  commit, or a close without merging on every send that linked the pull
  request. Oxagen merges nothing.
- A stop is a `cancel` to the linked run. The send reads stopping until the
  host reports the cancel applied, then stopped. A stop asked for before the run
  links reaches the run when it links.
- A send no runtime claimed can be withdrawn at once. A claimed send is stopped
  first. When a stop was asked for and no run ever linked, because the host went
  away after its claim, a person may then withdraw the send. Ending it is that
  person's explicit decision, never a timeout, and a run that links later is
  cancelled, so a crashed claimant cannot release the send into a second run.

The checks a base branch requires come from two reads: the branch's protection
summary and its rulesets. They are recorded only when both reads succeeded. An
empty list opens Accept on a person's ticks alone (oxageninc/roadmap#279), so a
failed read must never stand in for "none required". GitHub's check runs carry
no app id here, so a required check is matched by name.

### Accept

Accept reads GitHub again at the press, in three steps: read the item, read
GitHub and record the evidence in one transaction, then record the acceptance in
a second transaction that names the version the first one left. The acceptance
is admitted against the fresh evidence, so a failing, missing, cancelled, or
skipped required check, a new head, or a required list that could not be read
refuses it. The evidence stays recorded either way. Acceptance merges nothing,
and a work item is done once it is accepted and merged, in either order
(ADR-244).

### Who decides

Every decision on a work item (save and approve a brief, send, withdraw, stop,
return, accept, read checks, close, reopen) is a signed-in person's. An API key
and an agent run are refused, because an agent holding its operator's key could
otherwise approve, send, or accept its own work. The person also needs a role
the action takes in the item's own workspace (`workActionRoles`). So these
capabilities declare only the `api` surface: the app reaches them through the
kernel with the person's session, and no MCP tool or CLI command is offered. The
runtime's two calls use the host key and check the host against the order.

A send also checks two duties (ADR-244): the sender operates the target agent,
which ADR-198 makes the agent principal's parent user, and in a regulated
workspace the person who approved the brief cannot send it. The governance mode
is read from the workspace's steering repository. A workspace with no steering
repository has no mode. One whose repository is bound but cannot be read is
refused, because the mode might be regulated.

A return records the return and, by default, sends the item again to the same
agent with the reason in the next first prompt. When that send is refused, the
return stands and the item waits in ready.

### Mandate and budget

The send records the agent principal's active mandate whose validity started
last, or none. A work item adds no authority, so the mandate is recorded and
never widened.

Nothing reserves budget when a person presses Send. The send records the
runtime's tier, a forecast from what the control plane itself observed of the
host: `contained` when the runtime requires the contained launcher, `observe`
when the host is in observe mode, `gateway` when the control plane has
authorized a gateway call on the host's own credential, and `harness`
otherwise. Budget is held before each model call only on the `gateway` and
`contained` tiers, and only when the agent's version sets a ceiling. On
`harness` and `observe`, spend is recorded after the run. The run's own tier
is recorded per session at ingest.

### Names

`return_work_order` and `accept_work_order` are a person's actions here.
`WORK_MCP_TOOLS` in `@oxagen/work` lists the same names as agent tools from the
earlier all-at-once plan, which registered none of them. A later lane that adds
agent tools on work orders takes other names. `check:naming` gains the verbs
`return`, `close`, `reopen`, `claim`, and `reject`.

## Consequences

- A host must run an oxagen build that advertises `work_orders` before it can
  receive a send. Until it does, the send is refused with the reason.
- A required check on a repository Oxagen cannot read keeps Accept blocked. A
  GitHub connection that cannot see the base branch's rulesets blocks Accept on
  that repository.
- GitHub has no reopen fact in ADR-244: a pull request closed and reopened stays
  closed on its send until a new send links it.
- The `pull_request` webhook carries no delivery id here. Each fact's dedupe
  key names what it says, so a redelivery records nothing new.
- A criterion claim from the agent has no capability yet. The review shows "no
  claim" until one is added.

## Alternatives considered

- **A new queue for work orders.** Rejected: the phase spec says to reuse
  dispatch, and the command channel already has leases, acknowledgements, and a
  host poll.
- **Deliver the brief as a `message` to the agent's next run.** Rejected: a
  message waits for a run someone else starts, and a run that starts for
  another reason would take it. The claim gives the send one owner before
  anything starts.
- **Link the agent's next root run without the work order's name.** Rejected: a
  person can have two sessions open, and the wrong one would take the send.
- **Treat a failed required-checks read as none required.** Rejected: an empty
  list opens Accept on ticks alone.
- **Let an API key accept.** Rejected: it would let an agent accept its own
  work with its operator's key.
