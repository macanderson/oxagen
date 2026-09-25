# ADR-182: The context registry follows the production branch

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** steering
- **Amends:** ADR-061 (a record is published only by `merge_context_pr`),
  ADR-178 decision 4 (a slug never changes).
- **Related:** ADR-099 (a workspace is born with its main repository),
  ADR-133 (a hand commit is the honest limit of review), issues #4283,
  #4141, #3241.

## Context

A workspace's records live in two places. The record files under
`.oxagen/rules/` on the main repository's production branch are what Stella
loads. The registry in Postgres (`agent.context_records`, its versions and the
promotions ledger) is what the app lists and what builds the policy bundle
every wrapped agent receives.

Only `merge_context_pr` wrote the registry. Anything else that changed the
branch left the two apart, and nothing noticed:

- A Context PR merged on GitHub never showed as merged, and its record never
  reached the registry. After #4141, pressing Merge on it told the person to
  dismiss the proposal and propose the wording again.
- A push to the production branch that added, edited, renamed or deleted a
  record file changed what Stella loaded and nothing else.
- A renamed file broke the record. The file name had to be
  `<lineage>.toml`, check 2 refused anything else, and the record page read
  the derived path and fell back to the stale mirror.
- A Context PR closed on GitHub stayed open in Oxagen and blocked its lineage.

The production App (`oxagen-connect`) already delivers `push` and
`pull_request` to `/webhooks/github/app`. The route handed them to ingestion
only, so steering never saw them.

A person with push access can change any field of any file. A slug that must
never change cannot be enforced against that.

## Decision

1. **The production branch is the truth, and the registry follows it.** A
   repository sync reads every file under `.oxagen/rules/` at the branch's
   head and makes the registry match: new records are published, changed ones
   get a new version, moved or relabeled ones are updated in place, and
   records whose file is gone or marked retracted are retired with a `retire`
   link on the ledger.
2. **A record is matched by the `lineage_id` inside its file, never by the
   file's name.** A file can have any name and sit in any subdirectory of
   `.oxagen/rules/`. The registry records where it was last seen in `path`.
   Oxagen still writes a new record to `<lineage>.toml`, and writes a revision
   to the record's current path.
3. **A slug can change.** When the `lineage_id` in a file changes and the file
   stays at the same path, the record keeps its id, versions and ledger, and
   takes the new lineage as its slug. A lineage that changes in the same
   commit as a move is a new record, and the old one retires. This supersedes
   ADR-178 decision 4. A label still changes without a new version.
4. **What triggers a sync.** The GitHub webhook routes a `push` to the
   production branch, and a `pull_request` event on a Context PR's
   `context/*` branch, by GitHub's repository id to every workspace whose main
   binding head names that repository. It sends `steering/sync.requested`.
   The GitLab webhook does the same for a merged merge request and, for
   projects attached after this change, a push to the default branch. A sweep
   every five minutes requests a sync for every workspace with a main
   repository. A sync reads nothing more when the branch head has not moved,
   and lists `.oxagen/rules/` only when the newest commit that touched it has
   changed, so a push that leaves the rules alone costs two API calls.
5. **A merge on the host publishes.** A Context PR merged on GitHub or GitLab
   points at the record the sync published for its lineage, with no reviewer
   on the ledger and the policy version `repository:sync`. Review on the host
   is the host's branch protection, as ADR-061 already says for `team`. A PR
   merged on the host whose file the sync refused is rejected with the reason,
   not linked to the version still in force. A PR closed without merging is
   rejected. A PR whose branch moved has its checks reset to pending. Pressing
   Merge in Oxagen on a PR the host already merged asks for a sync through the
   queue and says so; the sync never runs inside that request, where it could
   write an older head over a newer one.
6. **A merge from Oxagen keeps its reviewer.** For 90 seconds after a Context
   PR merges at the commit its checks passed on, the sync leaves that lineage
   to `merge_context_pr`, which records the reviewer. Both paths take one
   advisory lock per workspace and write versions and ledger links through the
   same functions. When the sync lands first anyway, `merge_context_pr` finds
   the same bytes already in force and adds the reviewer's promotion to that
   version instead of writing a second one.
7. **A file that fails validation publishes nothing, and says so.** The record
   it held keeps its last good version, and while any file's lineage is
   unknown nothing retires, since that file may be the record moved and broken
   in one commit. The problem is written to `agent.context_sync_state`, shown
   on the Steering page's freshness panel, and posted as the `Oxagen steering
   sync` check on the commit. A TOML error names its line and column, never
   the file's text. A record with no stamps, or a stamp its content no longer
   matches, publishes with a warning, because a person editing by hand cannot
   compute a SHA-256.
8. **A constraint's effect stays on the registry.** The record file has no
   field for require or forbid. An existing constraint keeps its effect. A
   constraint the registry has never held is refused, and the finding says to
   create it in Oxagen.
9. **A registry-only change to a repository record is refused.**
   `promote_context_record` refuses to retire, supersede or pin a record whose
   file lives under `.oxagen/rules/`, with `record_follows_repository`. The
   next sync would read the file back and silently undo it. The change goes
   through the file: a Context PR that removes it or marks it retracted.

## Consequences

- The Steering page shows where the sync stands and refreshes while one is
  pending. The Context PR list and the Repositories changes list refresh while
  a PR is open, so a merge on GitHub shows within about ten seconds.
- A record published by a hand commit has no approver on its ledger row. That
  is ADR-133's honest limit, now recorded instead of absent.
- Records written by `publish_context_record` carry no path and are never
  retired by the sync. The two generations stay unreconciled, as the
  repository-binding spec already says.
- GitLab projects attached before this change have hooks without push events.
  The sweep covers them until they are attached again.
- Agents (`.oxagen/agents/`) and skills still need a person to register them
  after merge. The sync reads only `.oxagen/rules/`, and the same trigger can
  carry the other directories later (#4293).
- A record written by `publish_context_record` has no path, so check 2 no
  longer stops a Context PR for its lineage. That PR moves the record into the
  repository, which is the direction this decision wants.
- The first sweep after deploy publishes any record file already on a
  production branch that the registry lacks, and retires any repository
  record whose file is gone.
