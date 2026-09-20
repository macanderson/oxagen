# ADR-119: Tool changes invalidate approval rules

Status: Accepted

Date: 2026-09-19

Related: #3133, #3142, ADR-070, ADR-072, ADR-111

## Context

An enabled approval rule records authority over the tool facts its author
reviewed. Reclassifying a tool can require a role that author does not hold.
Republishing a measure can turn a payment ceiling into a fee ceiling without
changing the rule's amount. The existing consequence stamp detects added tags
at evaluation, but it neither explains a disabled rule nor detects a changed
measure path, unit, type, or scale.

## Decision

Tool classification and publication are governance writes. Each acquires the
workspace rule-set lock before reading or writing tool versions. Rule authoring
uses the same lock. The tool change, affected rules, and invalidation events
commit together. Role and callback reads reuse the same transaction to avoid
waiting writers exhausting the pool around a nested connection checkout.

After a classification change, recheck each matching enabled rule against its
recorded author's current authority. Resolve `createdBy` from its public user
identifier. Never substitute the person classifying the tool. Disable a rule
whose author cannot be resolved or whose rule-writing checks refuse it. An
authorized author's rule stays enabled and retains its author and date while
its checked consequence set is refreshed.

A publish that changes a measure named in a rule's ceiling or allow list
disables that rule for explicit review, even if its author could pass the
current role and measure-kind checks. The old ceiling was not approved against
the new path, unit, type, or scale. Measures the rule does not name do not
invalidate it. A rule pinned to the previous version does not match the newly
published version and is untouched.

A newly matching tool also requires review. Wildcards cover the tools reviewed
when the rule was saved, not future declarations without a new review. This
includes a version-pinned pattern that first matches a newly published version.
This decision avoids an unbounded per-tool stamp in workspace settings.

Disabling follows automatically from the tool change. The classifier or
publisher needs no additional permission to disable another person's rule.
Refusing the classification because an old rule would become invalid was
rejected: an approval rule must not prevent a security-driven classification.
Authorization refusals disable rules. Infrastructure or audit-storage failures
roll back the entire transaction so state and evidence cannot diverge.

Store `disabledReason` on the rule with a reason code, tool version, timestamp,
and explanation. The API and MCP reads carry that field, and Tools displays
it. Switching off preserves the reason. A save or switch-on that reruns the
authoring checks clears it. Existing API and MCP adapters parse the shared
output contract. There is no dedicated approval-rule CLI command or CLI
surface in the current contract, so this change adds none.

Record `approval_rule.invalidated` in `security.security_events` inside the
same transaction, with the rule, tool, actor, and before/after governance facts
in the new JSONB detail column. Generate the event constraint from the shared
compliance taxonomy.

Remove the process-local rule cache. A next decision reads committed rules.
The mandate decision path takes a workspace share lock before reading tool
facts, retaining a consistent set of tool and rule facts through its decision
transaction. The auto-approval path reloads under that lock and rechecks again before its
deferred commit writes the release receipt. The separate approval-resume work
follows the same ordering.

## Relationship to deny generation

The classification trigger still bumps deny generation for kill switches.
That generation serves readers that already reload classification. Approval
rules need a state mutation and explanation, so a generation bump alone does
not settle their authority. Both mechanisms react to the same committed tool
change and serve different decision readers.

## Consequences

Publication and rule authoring serialize within a workspace. Decisions incur a
fresh rule read rather than accepting up to 30 seconds of stale authority.
Broad wildcard rules may need review when new tools appear. Operators can see
why a rule stopped approving and can reauthorize it against current facts.
