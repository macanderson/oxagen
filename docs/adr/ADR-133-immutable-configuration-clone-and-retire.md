# ADR-133: Clone and retire immutable configuration identities

Status: Accepted
Date: 2026-09-20
Supersedes: The future registered-identity rename proposal in ADR-128, Source identifiers determine draft filenames.

## Decision

A registered configuration keeps its slug for its lifetime. Organization and workspace aliases are separate. Cloning opens an editable draft with a distinct name and slug. It does not change the source record, retire it, transfer authority, or register a credential.

The default suffix is `-cloned`, followed by `-cloned-1`, `-cloned-2`, and so on when occupied. The stem is shortened only where the record type's existing length limit requires it. The server checks historical identities as well as live records. A proposed name is a suggestion, not a reservation. Creation refuses a collision, including a simultaneous submission, and a refreshed draft selects the next suffix.

## Supported records

- Registered agents with a repository definition. Copy configuration fields into a new agent proposal. Registration after merge mints a distinct principal and credential. Do not copy credentials, hosts, mandates, sessions, run tokens, or spend attribution.
- Repository skills under `.oxagen/skills`. Copy the skill file and its bounded source bundle into a create-only proposal. A new source name does not inherit an approved digest pin.
- Published steering records. Copy the classification, scope, and claim into a proposal on a new lineage. Preserve the original version and evidence references.

Source content is read in the current workspace and recorded by digest. Submission refuses a source whose digest changed after the draft was opened. Existing validation, delegation ceilings, role checks, and review requirements apply to the clone.

## Creation and retirement

Agent and skill creation use exclusive proposal branches. A clone cannot attach itself to another draft's open PR or replace a merged source file. Steering proposal creation serializes its lineage check and insert. An occupied lineage remains occupied by historical records and proposals.

Retirement remains a separate explicit action. `retire_agent` revokes the agent's access and closes its `valid_until` while retaining the key, principal, and historical spend references. `promote_context_record` retains its lifecycle ledger and closes `valid_until` for retire and supersede. Repeating retirement preserves the first end date and does not append another retirement. Promoting a steering version starts a new interval, while the ledger retains earlier intervals.

Skills have immutable configuration snapshots rather than a mutable registry identity. Retiring an approved skill proposes removal of its digest pin. Publication of the merged configuration ends its eligibility for new configuration snapshots. A previously pinned run retains its original snapshot, and historical resolution rows keep their references. The source file can remain in the repository for historical review.

## Consequences

A clone's PR grants no authority. Its review can alter the new configuration, and publishing it does not retire the original. Historical runs and spending remain attributed to their original identities.

Legacy retired rows have no recorded validity end. The migration initializes it from `updated_at`, the best retained timestamp. It does not claim to reconstruct the original retirement time. New retirement actions record their own end date.

This increment adds cloning and validity dates to existing retirement actions. The skill pin retirement control and Context retirement PR remain follow-up work. ADR-091’s deployment proof still gates additions to steering governance process.
