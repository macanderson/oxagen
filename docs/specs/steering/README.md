# Steering: the `.oxagen/` layout and the Context PR checks

The mechanism behind `open_context_pr` and `merge_context_pr` (ADR-061; MC
spec §10). Records are governed like code: authored in the workspace's
repository, proposed as a pull request, published on merge. The registry in
Postgres mirrors what git holds; git decides what is in force.

## The repository

The workspace's repository is the one its GitHub source connection names
(`ingestion.source_connections`, connector `github`, status `connected`,
`delivery_config.owner` / `.repo`). Its production branch is the repository's
default branch. Every call runs with the workspace's own token (ADR-020).

## `.oxagen/`

```
.oxagen/
  rules/
    governance.toml          # mode = solo | team | regulated
    ctx.<set>.<slug>.toml    # one published record per lineage id
```

`governance.toml` is read on the production branch when a Context PR is
opened and again when it is merged; a missing file means `team`; a file that
cannot be read refuses both.

A record file is context-record/v0.1 in the layout Stella's loader reads
(`stella-records/src/ingest/record.rs`), written by
`packages/handlers/src/context.steering.file.ts`:

```toml
schema = "context-record/v0.1"
set_id = "a-intel.platform"

[[record]]
lineage_id = "ctx.release.no-reread-changelog"
record_id = "rec_release_no_reread_changelog_9a41c0e7bd23"
record_hash = "sha256:…"
kind = "rule"
statement = "Do not re-read CHANGELOG.md more than once in a run; cache the first read."
origin = "user"
sharing_scope = "workspace"
status = "active"

[record.provenance]
source_kind = "proposal"
source_uri = "oxagen:proposal/prp_…"

[record.steering]
force = "should"
```

- The file stem is the lineage id; the path is `.oxagen/rules/<lineage>.toml`;
  the branch is `context/<lineage>`.
- `set_id` is the repository's full name with `/` as `.`.
- `origin` is `user` for a person's proposal and `inferred` for an agent's.
- Only members Stella's `Record` struct carries enter the file. Stella
  re-serializes the typed struct before it recomputes the hash and would drop
  anything else from its preimage.
- `record_hash` is SHA-256 over the RFC 8785 canonical bytes of the record
  with `record_hash` removed and every null-valued member stripped
  (`packages/run-evidence/src/record-hash.ts`, pinned to Stella's golden
  digest). `record_id` is `rec_<slug>_<first 12 hex of the hash with both
  identity fields absent>`, `slug` being the lineage without `ctx.`, lowercased,
  with anything but `[a-z0-9]` as `_`.

## The lifecycle

```
proposed → pr_open → checks_running → checks_passed → merged
                                    ↘ checks_failed ↗
rejected
```

`open_context_pr` on a `proposed` row branches from the production branch,
commits the single file, opens the PR (its body: the record, the rationale,
the supporting records, runs and agents, the evidence links, the check list)
and runs the checks. On a row whose PR is open it runs the checks again on the
same PR, against its current head (`head_sha` re-read from GitHub). At most
one proposal per lineage is in an open-PR state
(`context_proposals_open_pr_idx`).

`merge_context_pr` is refused until `checks_passed`, unless the caller is a
reviewer the governance mode allows, and when the PR's head is no longer the
commit the checks ran on (`head_moved`). GitHub merges first (squash, pinned
to that commit); a PR GitHub already holds merged is resumed from its merge
commit. The head branch is deleted, then a confirmed merge publishes: the
registry row, a new immutable version holding the file at that commit, the
promotion event on the ledger (`agent.context_promotions`, `action = promote`,
`policy_version = governance:<mode>`), the proposal to `merged`, and the
`steering.published` audit event. The workspace's steering version is the
ledger length. `dismiss_proposal` closes an open PR and deletes its branch.

`open_context_pr`, `merge_context_pr` and `dismiss_proposal` gate on the
caller's role and so need a signed-in user; they declare the `api` surface
only, since an API key (the MCP and CLI bearer) carries no user.

## The checks

`packages/handlers/src/context.steering.checks.ts`, in order, one at a time,
each written to the proposal before the next starts and mirrored as a GitHub
check run `Oxagen · <title>` on the head commit. The file checked is the one
read back at that commit, and once every check passes the proposal carries
the `record_id` and `record_hash` stamped in it. Every check runs even after
a failure.

| # | name | what passes | what fails |
| --- | --- | --- | --- |
| 1 | `schema` | TOML; `schema = "context-record/v0.1"`; `set_id`; one or more `[[record]]` each with `lineage_id`, a `kind` from the six, `statement`, `origin` from Stella's five, `sharing_scope` from Stella's four, `status`, `record_id`, `record_hash`, `provenance.source_kind`/`source_uri`, `steering.force` from the four | anything else, named by field |
| 2 | `lineage_uniqueness` | exactly one record; its lineage is the proposal's and the file stem; no published record holds the lineage at another path | two records; a foreign lineage; a lineage published elsewhere |
| 3 | `record_hash` | `record_id` and `record_hash` recompute from the file's canonical bytes | an edit after stamping |
| 4 | `secret_pii_scan` | no credential token (vendor prefix, JWT, high-entropy blob), sensitive-key value or PEM block; no email, SSN or Luhn-valid card number — in the statement, rationale, evidence and file | any finding, named by field |
| 5 | `conflict_against_active` | no active constraint of the opposite effect on the same lineage, or on the same statement under another lineage | a `forbid` against an active `require` |
| 6 | `constraint_effect` | the file's kind, `steering.force`, `sharing_scope` and statement are the proposal's; a constraint carries `require` or `forbid`; no other kind carries an effect | a file re-stamped with another statement, force or scope; `allow` is unrepresentable; a constraint without an effect; an effect on a rule |

Truth probes (spec §10.3) are not declared by the files this lane writes and
are not a check here.
