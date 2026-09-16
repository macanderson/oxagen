# ADR-070: Auto-approval rules: the policy matrix, the rule store, standing approvals

- **Status:** Accepted
- **Date:** 2026-09-16
- **Owners:** platform
- **Refines:** ADR-059 (a mandate's own approval rule decides before this one
  and outranks it), ADR-052 (writing governance is a settings write, outside
  the metering surface).
- **Related:** the Mission Control spec §6.9 part 2, §6.10, §6.12, App. A.6,
  App. E; `apps/app/ARCHITECTURE.md` §1.2, §3.2, §8, INV-10, INV-29; GitHub
  issue #2970 and its scope note of 2026-09-14;
  `packages/oxagen/src/approval-rules/schemas.ts`,
  `packages/rules/src/auto-approval.ts`,
  `packages/rules/src/auto-approval-path.ts`,
  `packages/rules/src/call-facts.ts`, `packages/rules/src/rule-store.ts`,
  `packages/database/atlas/migrations/20260916120000_auto_approval_columns.sql`.

## Context

Spec §6.9 part 2 defines auto-approval as an approval rule whose conditions,
when met, let Oxagen skip the human, and names the conditions: a measure under
a threshold, a counterparty or environment on an allow list, a call inside a
mandate's remaining authority, a standing approval of the same call digest
inside a window the rule names, no taint, or business hours. An auto-approved
call is recorded as an approval whose approver is `policy:<rule id>`, so the
receipt says plainly that no person looked.

Half of the machinery is in the tree. `@oxagen/rules` is a workspace
decision-rules engine wired into the kernel gate; its effects are `allow`,
`deny` and `require_approval`, it loads a rule set through one seam, and it
already runs a mandate check for agent principals. What it does not have is
the other direction: a rule that resolves an approval the policy step would
otherwise park.

Issue #2970 names three decisions the slice cannot be built without.

## Decision

### 1. The policy matrix is four floors in code, read off the record

Auto-approval is refused, whatever a rule says, when any of these holds. They
are checked before any rule's own conditions and no rule can name, lift or
outrank them (`HARD_FLOOR_REASONS` in `packages/rules/src/auto-approval.ts`):

| floor | read from | reason code |
|---|---|---|
| the capability has no enabled declared tool | `agent.tools` + `agent.tool_versions` | `tool_not_declared` |
| the call's arguments derive from untrusted input | the call | `tainted_input` |
| the tool version's risk grade is `critical` | `tool_versions.risk_grade` | `critical_hazard` |
| the tool version carries a consequence the record marks irreversible | `tool_versions.consequence_tags` | `irreversible_consequence` |

Two things about that table are deliberate and are not silently rounded off.

**The spec's `irreversible` side-effect class is not a column.** A tool version
records a risk grade, consequence tags, measures and an effect-id path, and no
side-effect class (ADR-059 decision 6). The floor therefore reads the starter-set
tag that means the same thing — `destroys_data`, an action that cannot be undone
— through `IRREVERSIBLE_CONSEQUENCE_TAGS`. When a side-effect class is recorded,
the floor reads it and the constant goes.

**Nothing in this tree records taint.** No frame carries whether a call's
arguments derive from untrusted input; `tainted` appears on the `get_run`
receipt shape and nothing writes it. The floor is written, tested and live, and
the fact it reads is supplied by the subject builder as `false` until the frame
that carries taint lands. It is not defaulted to `true`, because that would
refuse every auto-approval and make the feature inert, and it is not left out,
because a floor added later is a floor that was missing in between.

**No trust or spend floor.** The mockup's rules carry `minTrust` and
`minSpend`, both read off the agent scores. #2969 cut the scores and their
percentile bands from this release, so a floor over them could never be met and
a rule field for them would be a switch wired to nothing. The spec's own list of
auto-approval conditions (§6.9 part 2) does not name a score. They are not rule
fields, and the mockup's `agent unknown` and `score provisional` reasons do not
exist in this evaluator.

**No `within_mandate` condition.** "A call inside a mandate's remaining
authority" is one of the spec's six conditions, and it is already true of every
call the evaluator can see: the mandate check reserves authority before the
approval hop is reached, and a call that did not fit was refused `over_limit`
before any rule was read. A rule field for it would have no discriminating
power.

### 2. The rules are the second clause of the rule set already stored

They live in `workspace.workspaces.settings.decisionRules`, beside the gate
rules, under the discriminator `oxagen.decision-rules.v2`, loaded through the
loader the gate already uses. A `v1` document parses unchanged and reads as a
rule set with no clause.

Issue #2970 recommended the context-record registry instead, for versioning and
an approval chain. That registry is a store of prose records with a
classification and a promotion ledger (ADR-061), not of structured rules, so
adopting it would mean building a second, typed record kind before a single
rule could be written. The decisive argument for the settings bag is the
decision path: the gate loads that document on every scoped `invoke()` and
caches it for 30 seconds, so putting the auto-approval clause in it costs zero
extra reads at decision time, while any other store costs one per parked call.
`RuleSetLoader` stays the seam; moving the document to a versioned registry
record later changes `packages/rules/src/rule-store.ts` and nothing that calls
it. `iam.role_grants.conditions_jsonb` stays the home of grant-time conditions
(time window, IP), which are not approval rules.

The clause is a separate array rather than a block on a gate rule with
`effect: "allow"`, which is how #2970 sketched it. A gate rule and an
auto-approval rule answer different questions: the first decides whether the
call may proceed at all, the second whether a call already sent to a person may
skip them. Riding `effect: "allow"` would conflate them, and because an `allow`
verdict stops evaluation, writing an auto-approval would silently outrank every
later deny rule in the set.

`set_approval_rules` writes the clause with `jsonb_set` on that one key, so a
concurrent write of any other settings key survives it.

### 3. A standing approval is rule-named, bounded to the workspace and the digest

`standingWindowMs` is per rule, between one minute and 30 days, absent by
default. The fact it is measured against is the most recent approval in the
workspace of the same canonical input digest that a person resolved
(`lastHumanApprovalOf`).

It is bounded to the **capability** as well as the input. `input_digest` is
sha256 over the input alone, so two capabilities called with the same payload
share a digest; without the capability in the predicate, a person's approval of
`archive_thing {"id":"x"}` would open a standing window for
`delete_thing {"id":"x"}`. A call is a capability and its input, and
`approval_requests.capability_name` records it, so the lookup narrows on both.

It is not bounded to the agent or the run's task, as #2970 recommended, because
no approval row records either: `agent.approval_requests` carries the mandate,
the rule ids, the digest and the message, and `list_approvals` reports
`chain.agentKey` as null for exactly this reason. Binding it to the agent is one
column away and belongs with the lane that records the agent on an approval.

### 4. The evaluation is recorded, and read back rather than recomputed

`agent.approval_requests` gains three columns: `auto_rule_id` (the rule that was
read when the call was parked, whether or not it qualified), `resolved_reasons`
(every reason it did not qualify, empty when it did) and `resolved_by_policy`
(`policy:<rule id>` on a call no person looked at). A CHECK holds the form of
the third, and another holds it exclusive with `resolved_by_user_id`, so one
approval never has two approvers and an auditor can never read a policy decision
as somebody's.

`get_auto_eligibility` and `list_approvals` read those columns. They do not
re-evaluate: a rule edited since the call was parked is a different rule from
the one that judged it, and the page must show the decision that was made
(INV-10).

The mockup's per-rule counters are a grouped count over those rows in a 30-day
window, computed by the read. There is no rollup table and no nightly job: the
approval rows are the record, the rule set holds tens of rules, and a figure
derived at read time has nothing to fall out of date.

Both figures therefore count the calls that produced an approval row.
`hits30d` is the calls a rule released; `skipped30d` is the calls that reached
a person's queue with the rule recorded beside them. A `require_approval`
verdict that no rule released writes no approval row — the gate refuses the
call rather than queueing it, and a row nobody could act on would be worse than
none — so it is in neither figure. The field says so, and the counters are not
described as "every call the rule was read against".

### 5. Where it fires, and where it does not

The gate asks once, at a `require_approval` verdict, before it throws. A rule
that qualifies writes the approval row already resolved with its single-use
token spent, and the call proceeds; anything else leaves the call with the
person it was already going to.

A mandate's own approval rule is not answerable this way. It parks the call and
outranks any workspace rule (§6.9 part 3), so `decideMandate` records the
evaluation beside the row it parks and parks it anyway. That is what lets the
approval card say "auto-approval eligible — parked anyway: the mandate requires
a human above its threshold" rather than pretending no rule was read.

### 6. "A rule cannot be saved that would widen an agent past its operator's grants" is mechanical

`set_approval_rules` resolves every declared tool each rule's patterns match,
collects their consequence tags, and requires the caller to hold an org role the
workspace names for all of them (`assertConsequenceRole`, the same gate a
mandate grant clears). Whoever may not grant authority over money may not write
the rule that lets a call carrying money skip a person. Two guards ride with it:
a pattern that matches no declared tool is refused, and a condition over a
measure a matched tool does not declare is refused — denied by construction,
the same rule a mandate's limits clear.

Switching a rule back **on** re-runs those guards, because a tool's
classification can change while a rule is off. Switching it off does not: it can
only send more calls to a person.

## Consequences

- One rule engine, one store, one loader. Nothing parallel to `@oxagen/rules`.
- An auto-approval is a row an auditor can find, count and attribute, and the
  form of its approver is enforced by the database.
- A workspace that authors no clause pays nothing: the gate's existing load
  answers, and the hook is never called.
- The taint floor does not fire until taint is recorded. That is stated on the
  subject builder, in this ADR, and nowhere else does anything claim taint is
  checked.
- Trust and spend floors, and the `agent unknown` / `score provisional` reasons
  the mockup renders, land with the scores if the scores land.
- Three security event types (`approval.auto_approved`, `approval_rule.changed`,
  `approval_rule.deleted`) and the regenerated `security_events` CHECK.
