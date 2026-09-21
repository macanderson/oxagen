# revise_context_record

**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api
**Risk level:** high (requires approval on the agent surface)
**Billing gate:** none (noBillingGate: true)

## Intent

Change what a published record says, as a pull request. The call raises a
proposal that carries the record's kind, force, constraint effect, and sharing
scope exactly as they stand, with the new statement, then runs
[`open_context_pr`](context.pr.open.md) on it. That is the one path that writes
`.oxagen/rules/<lineage>.toml`, opens the pull request, and runs the six
MC spec §10.3 checks, so an revision gets the same branch, the same
single-file commit, and the same checks as any other steering change.

The record keeps its lineage, because an revised record is the same record. Its
`record_id` and `record_hash` are recomputed over the new bytes; the old hash
stays true of every run that carried the old ones.

The record being revised is read the way its page reads it: the file on the
production branch first, the registry mirror only when no file answers. An
revision therefore carries forward what is in force, not what the mirror last
remembered.

To change a record's kind, force, or effect, use
[`propose_record`](context.proposal.create.md). That is a different record.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| recordId | string | The lineage (`ctx.…`) or the public record id (`ctr_…`) |
| statement | string | The new statement, 1 to 2000 characters. The only field an revision changes |
| rationale | string (optional) | Why it changed. Recorded on the proposal and in the pull request body |

## Output

The [`open_context_pr`](context.pr.open.md) output: the proposal id, its
status, the branch, the pull request number and url, and each of the six checks
with its verdict.

## Side effects

Inserts one `agent.context_proposals` row, pushes one commit to
`context/<lineage>`, and opens or reuses one pull request against the
repository binding's approved branch. Nothing is in force until that pull
request merges. The registry is written by
[`merge_context_pr`](context.pr.merge.md), not here.

## Errors

- No record for that lineage or id in this workspace, in the file or the
  registry → `not_found`, `record_not_found`.
- A record whose kind, force, or sharing scope this workspace does not hold
  → `conflict`, `record_unclassified`. The §10.3 schema check would refuse the
  commit; republish the record with its classification first.
- A constraint whose require or forbid effect this workspace does not hold
  → `conflict`, `constraint_effect_unknown`. Use `propose_record`, which states
  the effect.
- The caller holds none of Owner or Admin on the org, and none of Owner or
  Member on the workspace → `forbidden`.
- Everything `open_context_pr` can raise, including a workspace with no
  repository binding and a lineage that already has a pull request open.
