# Existing Fleet, Run, Steering, Record and Skills functions

The requirements served at localhost:3310 come from `oxagen-roadmap/mockups/pages/*.md`. This inventory records existing functions and proposed placement. The user approved preserving these existing functions while changing their placement. The implementation introduces no backend capability.

| Existing function | Proposed placement | Difference to review |
| --- | --- | --- |
| Fleet run list, status filters, run commands, paging | Fleet | Retain every current action and recorded field. |
| Pending approval queue, mandate authority, approval decisions | Shared approvals drawer, with Fleet waiting tile entry | The waiting tile opens the shared drawer, which preserves the existing decision panel and mandate details. |
| Run transcript, search, kinds, raw bodies | Run Transcript | Retain all captured evidence and controls. |
| Run cost attribution and basis | Run Cost | Retain all cost instruments. |
| Chain frames, seal, export and raw frame body | Run Frames | The mock reorganizes these; keep the existing view available. |
| Run pending and resolved approval history | Run Approvals | The mock has inconsistent approval placement. Retain the full tab until reviewed. |
| Run artifact and file evidence | Run side column | Layout only; absent evidence remains distinct from no work. |
| Generated name and summary, workspace enrichment switch, harness identity | Run header and summary | Recent explicit user additions remain in place. |
| Published context records and record-kind filter | Steering Library Records | The All shelf can expose current records and observed skills, but cannot claim an exhaustive unified registry. |
| Observed skill inventory, configuration search, configuration versions | Steering Library Skills | Current inventory reports harness observations, not the mock's authored skill and repository-sync catalog. |
| Freshness auto-sync and stale-prompt refusal | Steering Freshness | Retain both switches and their recorded repository/version metadata. |
| Candidate proposals, Context PR checks, dismiss/open/merge actions | Steering Proposals, with Candidates and Context PRs sections | Retain all existing state transitions. |
| Full record statement, source editor, kind panel, lineage, related records | Record | Already substantially matches the reference. Keep the new label separate from statement content. |

Assignments and Compiler have no app read port. Ontology steering, In-loop and Reflection also lack the required app reads. Step one adds no page, navigation item or placeholder for those missing capabilities. Instructions have no published source in this Library and therefore gain no empty shelf.

Preservation rules: no existing Run tab or control is removed, no record field is dropped, no fixture data is introduced, and no unavailable read is represented by a zero count. The user approved this placement before implementation continued.

Validation remains in CI. Source and route regression tests cover canonical section paths, legacy selections, rejected selectors, retained inventory cursors. No local test file was run for this draft.
