# set_approval_rules

**Domain:** approval_rule
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Sensitivity:** high
**Metering:** none (`noBillingGate`, a settings write)
**App:** Tools › Auto-approvals › Create rule, and Edit on a row. The app reads the set, splices the one rule in, and writes the whole set back with the read as `replaces` and the rule's id in `saving`. An edit also carries the rule as the dialog rendered it, and the app refuses the save when the read no longer matches it, so a rule changed while the dialog was open is not written back from the stale editor. A rule whose tool pattern holds a line break or whose allow-list glob holds a comma opens with no **Save**: those are the delimiters the fields split on, so saving any field would write the pattern back as two and widen the rule. Edit such a rule here; it can still be switched off or deleted in the app.

## Intent

Write the workspace's auto-approval rules. Create and edit are the same
write: the caller sends the whole set and it replaces the stored clause
atomically, so two rules can never disagree about which one a call matched
first. An agent's call waits for a person (`agent.requiresApproval`).

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `rules` | `ApprovalRuleBody[]` | Up to 256. An empty array clears the clause. |
| `replaces` | `ApprovalRuleBody[]`, optional | The set the caller read and edited. The write is refused as `rule_set_changed` unless the stored rules still match it, so an edit to one rule cannot write back a rule someone else deleted or switched off meanwhile. |
| `saving` | `string[]`, optional | Ids of rules to check and stamp even when sent back unchanged. |

A rule sent back exactly as stored keeps its stamp: only new and changed
rules, and the ones `saving` names, run the role check and are re-stamped. An
edit to one rule therefore cannot re-authorise another rule that is held back
as `consequences_changed`.

A rule body is the rule shape without `createdBy`, `createdAt` and
`authoredConsequences`, which the handler records. Every condition defaults
off, so a rule names only what it asks for: `enabled` true, `maxMeasures` and
`allowTargets` empty, `standingWindowMs` and `businessHours` null.

`authoredConsequences` is the effective consequence tags the rule's tools
carried at this write — the union of the declared column and the classified
jsonb. It is the handler's to set and an author cannot supply it. The
evaluation compares a call's tool against it, so a tool classified AFTER a
rule was authored stops that rule releasing calls (`consequences_changed`)
until it is saved again, which re-runs the role check below. A consequence
REMOVED from a tool leaves the rule qualifying: losing one cannot make the
rule more dangerous than it was approved to be.

## Output

The same page `list_approval_rules` returns, so the caller needs no second
read.

## Writers

An org Owner or Admin, who must also hold the role the workspace names for
every consequence the rules' tools carry.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `no_principal` | No signed-in user on the request. |
| `forbidden` | `org_role_required` | The caller may not write rules, or may not write one over these consequences — spec §6.9 part 2's rule that a rule cannot be saved that would widen an agent past its operator's grants. |
| `forbidden` | `no_role_covers_all_tags` | No single org role is accountable for every consequence the matched tools carry together. |
| `conflict` | `no_tool_matches` | A tool pattern matches no declared, enabled tool in this workspace. |
| `conflict` | `measure_not_declared` | A condition names a measure a matched tool does not declare. |
| `conflict` | `rule_set_changed` | `replaces` no longer matches the stored rules; nothing was written. |
| `not_found` | `workspace_not_found` | The workspace is not readable in this scope. |

## SPEC references

- §6.9 part 2, App. E; ADR-070


## Tool changes and disabled rules

Tool classification and publication recheck matching enabled approval rules in
the same transaction as the tool write (ADR-119). A rule whose recorded author
no longer has authority is disabled. A changed measure path, type, unit, or
scale used by the rule, or a newly matching tool, requires explicit review.
The tool change itself is not refused because an existing rule fails that check.

`disabledReason` carries `code` (`classification_changed`, `measure_changed`, or
`tool_scope_changed`), `tool` (`slug@version`), `at`, and `detail`. API and MCP
reads return it, and Tools shows the reason. Switching off preserves it. Saving
or switching on reruns the authoring checks and clears it. The security event
`approval_rule.invalidated` names the rule, tool, actor, and before/after facts.
## External MCP tools

Auto-approval is unavailable for external MCP tools because they have no trusted cost or consequence measures. Saving an auto-approval rule for one returns `external_auto_approval_unsupported`.

Use the workspace decision-rules document for `deny` or `require_approval` rules instead. These match `mcp.<serverId>.<tool>` and `file-mcp.<serverName>.<tool>`, including server-prefix patterns such as `mcp.<serverId>.*`. An external identity is matched without regard to case, because the registry folds the case of the same name when it derives a tool's slug, so a rule in either spelling governs the call (ADR-138). Human approval applies to one exact call. A changed input or rule document requires a new decision. External calls by an agent principal remain refused until their mandate measures can be established. See ADR-122.

An auto-approval rule's tool pattern is matched against the registry slug, which is already lower case, so a pattern written in the server's own spelling is refused as `no_tool_matches` rather than folded.
