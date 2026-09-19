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
- `set_id` is the repository's full name with `/` as `.`, taken from the
  **binding** (`repository_bindings.provider_full_name`) and never from live
  GitHub. A repository rename therefore does not re-stamp later records: the
  name moves only when an owner re-approves it through `bind_main_repository`,
  which writes a successor binding — the same rule the production branch
  follows. A legacy wizard connection has no binding, so there the live name is
  the only one available.
- `origin` is `user` for a proposal a person raised and `inferred` for one an
  agent raised over an API key (the proposal has no `created_by_id`),
  whoever opens the PR.
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
same PR, against its current head (`head_sha` re-read from GitHub), and is
refused `base_moved` when the PR no longer targets the production branch. The
branch is written to the row before GitHub is touched, so a call that failed
after GitHub opened the PR is retried onto that PR; an open PR on the branch
whose body does not name the proposal is refused `lineage_pr_open`. At most
one proposal per lineage is in an open-PR state
(`context_proposals_open_pr_idx`), every status write applies only from the
statuses it names, and each check write and the outcome write apply only
while the row's head is the one the checks read (`head_moved` otherwise).

`merge_context_pr` is refused until `checks_passed`, unless the caller is a
reviewer the governance mode allows, when the PR's head is no longer the
commit the checks ran on (`head_moved`), and when the PR no longer targets the
production branch (`base_moved`). GitHub merges first (squash, pinned
to that commit); a PR GitHub already holds merged is resumed from its merge
commit. The head branch is deleted, then a confirmed merge publishes: the
registry row, a new immutable version holding the file at that commit, the
promotion event on the ledger (`agent.context_promotions`, `action = promote`,
`policy_version = governance:<mode>`), the proposal to `merged`, and the
`steering.published` audit event. The workspace's steering version is the
ledger length. A published `must` or `should` record is compiled into the
policy bundle's `context.system` (`packages/handlers/src/lib/tacho-steering.ts`,
ADR-091), so the merge moves the bundle etag and every enrolled host picks the
record up on its next poll. `dismiss_proposal` closes an open PR (one found on the branch
whose body names the proposal, when the row never recorded its number) and
deletes its branch, and writes `rejected` only to a proposal that is not
merged.

`open_context_pr`, `merge_context_pr` and `dismiss_proposal` gate on the
caller's role and so need a signed-in user; they declare the `api` surface
only, since an API key (the MCP and CLI bearer) carries no user.
`propose_record` and `append_record` check the contract's roles for a
signed-in caller and leave an API-key call to the kernel.

## The checks

`packages/handlers/src/context.steering.checks.ts`, in order, one at a time,
each written to the proposal before the next starts and mirrored as a GitHub
check run `Oxagen · <title>` on the head commit. The file checked is the one
read back at that commit, and once every check passes the proposal carries
the `record_id` and `record_hash` stamped in it. Every check runs even after
a failure.

| # | name | what passes | what fails |
| --- | --- | --- | --- |
| 1 | `schema` | the PR changes the record file and no other path (compare from the production branch to the head; a rename counts both paths); TOML; `schema = "context-record/v0.1"`; `set_id`; one or more `[[record]]` each with `lineage_id`, a `kind` from the six, `statement`, `origin` from Stella's five, `sharing_scope` from Stella's four, `status`, `record_id`, `record_hash`, `provenance.source_kind`/`source_uri`, `steering.force` from the four | any other changed path, named; anything else, named by field |
| 2 | `lineage_uniqueness` | exactly one record; its lineage is the proposal's and the file stem; no published record holds the lineage at another path | two records; a foreign lineage; a lineage published elsewhere |
| 3 | `record_hash` | `record_id` and `record_hash` recompute from the file's canonical bytes | an edit after stamping |
| 4 | `secret_pii_scan` | no credential token (vendor prefix, JWT, high-entropy blob), sensitive-key value or PEM block; no email, SSN or Luhn-valid card number — in the statement, rationale, evidence and file | any finding, named by field |
| 5 | `conflict_against_active` | no active constraint of the opposite effect on the same lineage, or on the same statement under another lineage | a `forbid` against an active `require` |
| 6 | `constraint_effect` | the file's kind, `steering.force`, `sharing_scope` and statement are the proposal's; a constraint carries `require` or `forbid`; no other kind carries an effect | a file re-stamped with another statement, force or scope; `allow` is unrepresentable; a constraint without an effect; an effect on a rule |

Truth probes (spec §10.3) are not declared by the files this lane writes and
are not a check here.

## Freshness: the other half of the lifecycle

Everything above publishes a record. This section is about the checkout that
has to read it.

A Context PR merges onto the production branch. A developer on a feature
branch keeps whatever `.oxagen/` their branch point had, so the longer the
branch lives the more likely the agent running in it is steering on records
nobody uses any more. Nothing in the lifecycle above notices that, because
from the platform's side the record was published and the story ended.

`@oxagen/steering-freshness` is the answer, and the `oxagen steering`
commands are its surface.

### What "stale" means

From the merge base of the checkout's HEAD and the remote production branch:

- changes on the **remote** side are records that merged without this
  checkout. That is staleness, and it is the only thing that may block a run.
- changes on the **local** side are records being authored here. That is
  never staleness.

Both lists are narrowed to the paths whose working copy differs from the
production branch, so a record already on disk stops counting whether it
arrived by sync, cherry-pick or hand. Every failure to answer is `unknown`,
and `unknown` never blocks.

### The two gates

`autoSync` takes the merged records into the checkout before the prompt runs.
`blockStaleRuns` refuses the prompt while records are missing. Both live in
the `steering` block of the Oxagen settings files, and both are also
workspace policy in Oxagen (Steering → Steering freshness), stored
in `workspace.workspaces.settings` and read by `get_steering_freshness`.

The scopes combine with OR: a later scope may switch a gate on, and may never
switch one off. Otherwise `.oxagen/settings.local.json`, which a developer
owns and which is not committed, could switch off the gate the organisation
set. `OXAGEN_STEERING_FRESHNESS=off` suspends both for one shell.

`.oxagen/settings.json` is read twice: from the working copy, and from the
production branch as it was last fetched. The working copy is whatever was
last typed into it, so on its own an uncommitted edit could switch off a gate
the team committed. A branch can still switch a gate on before it merges.

### What a sync refuses

`oxagen steering sync` takes `.oxagen/` from the production branch and leaves
it staged. It refuses when the verdict is `unknown` (acting on a non-answer
is how a record gets deleted over a failed fetch), when the branch has its
own `.oxagen/` changes, and when anything under `.oxagen/` is uncommitted,
including a file this sync would not have written. `--force` covers the first
two and never the `unknown` case.

A sync the gate starts shares the hook's deadline. It refuses with
`out_of_time` rather than starting a write it cannot finish inside the twenty
seconds the harness gives the hook, and a deadline that arrives between
batches stops it and reports how many files landed. `applied` stays false in
both cases, so a blocking policy still refuses the prompt rather than the
harness killing the gate and letting it through over a part-written
`.oxagen/`.

### Reaching the agent

Oxagen wraps whatever agent a team runs, so the gate is one command with a
contract every harness can call: exit 0 allows, exit 2 refuses with the
reason on stderr, and `--harness` picks the JSON on stdout. Claude Code and
Codex CLI both take it as a `UserPromptSubmit` hook, which
`oxagen steering hooks install` writes for them; the warning goes into the
turn as `additionalContext`, so it reaches the transcript and not only a
terminal nobody is watching.

`--harness all` covers every harness Oxagen wraps: Claude Code, Codex, Cursor,
and Stella, each with its own config writer and its own output adapter. A
harness name Oxagen does not know renders as text and signals by exit code,
which is the contract any shell already understands.

For an agent with no pre-prompt hook, the `get_steering_freshness` MCP tool
is the reach that is guaranteed. It answers later, at the first tool call
rather than before the prompt, which is why the hook is still the better path
where a harness supports one.
