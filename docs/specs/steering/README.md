# The steering repo

Each workspace keeps its steering in a repository of its own, the steering
repo. Oxagen creates it when you create the workspace, merges every change to
it, and publishes each merge as a numbered version. Each organization has one
more, `<org>/oxagen`, for the records every workspace in it shares. Code
repositories hold no committed steering. A workspace links a code repository
with a steering PR (ADR-212, `docs/specs/repository-binding/README.md`).

The code is in five places:

- `packages/oxagen/src/steering-repo/` holds the layout, the names, and the
  record and ledger formats.
- `packages/handlers/src/steering_repo.provision.ts` creates the repository.
- `packages/handlers/src/steering-repo/` holds the stamp, the merge queue, and
  the publisher.
- `packages/steering-check` holds the checks.
- `packages/steering-bundle` builds what a published version sends a model.

## Repository layout

A workspace's steering repo is `oxagen-<workspace-slug>`, with `-2`, `-3`,
and so on when the name is taken. Its default branch is `main`. Provisioning
and each merge through the app record a deployment to the `steering`
environment.

```
oxagen-<workspace-slug>/
  README.md
  AGENTS.md
  CLAUDE.md
  .gitattributes
  workspace.toml                  # workspace repos only
  agents/<name>.toml              # agent/v1
  steering/
    governance.toml               # governance/v1: mode = solo | team | regulated
    promotions/<period>.jsonl     # the ledger, written by Oxagen
    skills/<lineage>/SKILL.md     # one folder per skill
    memory/<lineage>.md
    <any folder>/<lineage>.md     # a steering record
  tools/
    servers/<name>/               # server.toml, tools.toml, tools.lock.json
    toolbelts/<name>.toml
  policy/
    schema.cedarschema
    <group>.cedar
    <group>.tests.jsonl
```

- A steering record is any `.md` file under `steering/` outside
  `promotions/` and a skill's folder. Its name is `<lineage>.md`. Folders
  carry no meaning, so you can move a record between folders and it stays
  the same record.
- A skill is `steering/skills/<lineage>/SKILL.md`. Other files in the folder
  travel with it.
- `steering/promotions/` is the ledger. Oxagen writes it when it stamps a
  steering PR, and it refuses a steering PR that touches it. A new file
  starts each day, ISO week, month, or year, as `[ledger] rotate` sets. A
  period holds up to 999 files, from `<period>.jsonl` to
  `<period>.999.jsonl`.
- `workspace.toml` lists the code repositories the workspace links, one
  `[[repositories]]` entry each, with a `url` such as
  `github.com/a-intel/platform`. The organization repo has no
  `workspace.toml`.

The first commit, "Seed the steering repo", writes `README.md`, `AGENTS.md`,
`CLAUDE.md`, `.gitattributes`, `workspace.toml`, and
`steering/governance.toml`. The repository-binding spec covers the seven
provisioning steps.

## Record format

A steering record is Markdown with YAML frontmatter, schema
`steering-record/v1` (`packages/oxagen/src/steering-repo/record.ts`). The body
is the statement. This is a record as you write it:

```markdown
---
schema: steering-record/v1
lineage: a-intel.platform.no-push-to-main
label: Protect main
description: Only pull requests reach main.
kind: constraint
effect: forbid
force: must
scope: workspace
status: active
origin: user
provenance:
  source: proposal
  uri: oxagen:proposal/prp_01K5X4BA
---

Do not push commits straight to `main`.
```

The fields:

| Field | Values | Notes |
|---|---|---|
| `lineage` | dotted name | The record's identity. It matches the file name. |
| `label` | text | The name every surface shows first. It can change freely. |
| `description` | text | Up to 200 characters, or 1,024 for a skill. |
| `kind` | `business-rule`, `code-rule`, `constraint`, `procedure`, `skill`, `fact`, `preference`, `memory` | |
| `effect` | `require`, `forbid` | Constraints only, and every constraint needs one. A record grants no authority. |
| `force` | `must`, `should`, `may`, `info` | |
| `scope` | `workspace`, `repository`, `organization` | `repository` needs `repos`. |
| `repos` | list of `<host>/<owner>/<name>` | The code repositories the record applies to. |
| `load` | `always`, `match`, `relevant`, `mention` | Defaults to `always` for `must` and `should`, and to `relevant` for the rest. |
| `status` | `active`, `archived` | |
| `origin` | `user`, `inferred` | |
| `provenance` | `source`, `uri`, `agent`, `memories` | `source` is `proposal`, `run`, or `import`. |
| `id`, `hash` | written by the stamp | You do not write these. |

A skill also needs `name`. Four optional fields narrow a record:

- `tools` lists tool names or `<server>__*` prefixes. The record reaches a
  request only when the run's toolbelt holds a match.
- `skills` lists skill lineages. The record reaches a request only when the
  request's skill is on the list.
- `applies_to` lists path globs, which `load: match` reads.
- `toolbelt` names a toolbelt in `tools/toolbelts/`. What it does waits for
  a later version of the spec.

## Steering PRs

Every change to a steering repo is a steering PR, and Oxagen merges it. A person or an agent can open one from any git client. The app opens
them too, for a proposal, a governance change, or a repository link.

### Branch names

A steering PR's branch starts with the folder it changes
(`packages/handlers/src/steering-repo/stamp.ts`, `branchScopeRefusal`):

| Prefix | Changes | Files per PR |
|---|---|---|
| `steering/` | records, skills, and `governance.toml` | one record, one skill folder, or one file |
| `memory/` | `steering/memory/` | many |
| `tools/` | `tools/` | many |
| `agents/` | `agents/` | one file |
| `policy/` | `policy/` | one policy group |
| `workspace/` | the root files, including `workspace.toml` | one file |

A branch for one record is `steering/<lineage>`. The check refuses a branch
for one of four reasons:

- `branch_prefix`: the branch starts with none of the six prefixes.
- `ledger_owned`: the PR changes a file under `steering/promotions/`.
- `branch_scope`: a changed path belongs under another prefix.
- `one_change`: a branch other than `memory/` or `tools/` changes more than
  one unit.

### Checks

`@oxagen/steering-check` runs eleven checks: `schema`, `lineage`, `hash`,
`secrets`, `conflicts`, `authority`, `settings`, `references`, `budget`,
`compile`, and `owned`. Oxagen posts the result as one required check,
`Oxagen steering`, on the PR's head. `oxagen check` runs the same checks on a
local clone and skips `settings`, which needs the host.

### Approval

`steering/governance.toml` sets the mode, and a new repository starts in
`solo`. In `solo` mode the merger is the approver. In `team` and `regulated` mode the PR needs an approval on the host
at the checked head, from a workspace member other than the author. Without
one, an owner, or a member who holds `merge_pr_without_review`, can still
merge, and the ledger records `without_review: true`.

### Merge

You merge from the app (`merge_context_pr`). Oxagen then works through its
merge queue (`packages/handlers/src/steering-repo/merge-queue.ts`), one
steering PR at a time per repository:

1. Oxagen brings the branch up to date with `main` when it is behind, and runs
   the checks again.
2. Oxagen pushes one stamp commit. It writes `id` and `hash` into each record
   the PR changed and appends one ledger line.
3. Oxagen reads `main` again. When `main` moved, it drops the stamp and starts
   over.
4. Oxagen squash-merges, pinned to the stamped commit. The message ends with
   the `Oxagen-Approved-By`, `Oxagen-Checks`, and `Oxagen-Version` trailers.

While the repository fails its health check, Oxagen merges nothing.

### Stamp

The stamp computes each record's identity from its content:

- The preimage is the frontmatter without `id`, `hash`, `label`, and null
  values, plus `statement`, the trimmed body.
- The seed is `sha256` over the RFC 8785 canonical JSON of the preimage.
- `id` is `rec_<slug>_<first 12 hex digits of the seed>`. The slug is the
  lineage in lowercase, with each character outside `[a-z0-9]` as `_`.
- `hash` is `sha256` over the canonical JSON of the preimage plus `id`.

`label` stays out of both, so a rename changes neither.

### Ledger

Each merged steering PR adds one line, schema `promotion/v1`
(`packages/oxagen/src/steering-repo/promotion.ts`). A line holds `seq`, `at`,
the PR's provider and number, `branch`, `mode`, `approved_by`, `merged_by`,
and `without_review`. It also holds `changes`, one entry per file. Each entry
has `path`, an `action` of `added`, `modified`, or `removed`, and for a record
its `lineage`, `id`, and `hash`. `replaces` names the id a record had before a
format change, such as the v0.1 conversion. `prev` holds the hash of the line
before, across files, and `hash` covers the line itself, so the lines form one
chain.

### Publish

After the merge, `merge_context_pr` publishes the new head
(`packages/steering-bundle/src/publish.ts`,
`packages/handlers/src/steering-repo/publisher.ts`). The repository sync
publishes too, as its last step, so a merge made on the host still publishes.
A publish takes these steps:

1. It checks the repository's health and takes the repository's lock.
2. It skips a commit it already published, and a commit that is no longer
   the head of `main`.
3. It takes the next version number, one above the highest ever stored.
4. It builds a `bundle/v1` from the changed blobs, with tools from MCP
   Studio.
5. It stores the version, then moves the workspace to it.
6. It tags the merge commit `steering/<number>`.

The version store is `postgresVersionStore`, keyed by
`<host>/<owner>/<name>`, where the host is `github.com` or `gitlab.com`.

## Readers

- **The bundle.** For each linked code repository, a published version holds
  one block of the `must` and `should` records that load `always`, under
  `## Workspace rules` and `## Organization rules`. It renders the block once
  at publish, sorted by lineage. Every other record and skill becomes one line
  under `## More steering`. The frontmatter stays out of what the model reads
  (`packages/steering-bundle/src/render.ts`).
- **`steering_search` and `steering_read`.** The handlers exist in
  `packages/handlers/src/steering.search.ts` and `steering.read.ts`, and
  `packages/steering-bundle/src/cursor.ts` holds a Cursor dashboard rule that
  calls them. No contract registers them yet.
- **Wrapped agents.** `get_tacho_bundle` and `recall_tacho_memories` read
  through `TachoPublished`, which answers `NOTHING_PUBLISHED` on `main`. PR
  #4606 binds it to the version store.
- **Stella.** A reader for this layout is pending in the Stella repository.

## Workspace migration

A workspace set up before the steering repo keeps its steering under
`.oxagen/` in the repository it used to bind. An organization owner moves it
with one call per workspace, `import_workspace_steering`, in four steps:

1. Oxagen changes the old repository's head from `steering` to `linked`.
2. Oxagen provisions the workspace's steering repo.
3. Oxagen opens the import steering PRs. `steering/import-oxagen` carries the
   records, the skills, and `governance.toml`. `workspace/import-oxagen`
   carries `workspace.toml`. Each agent with a stored operator, runtime, and
   harness gets its own `agents/` PR.
4. In the same run, Oxagen opens one pull request on the old repository. A
   person merges it last, after the import steering PRs. It removes the
   committed steering files under `.oxagen/` that the steering repo now
   holds. A file that changed after the import read it stays, and the pull
   request lists it. The machine-local files that the repository-binding spec
   lists in §4 stay.

Oxagen writes only on a branch it can prove holds nothing but its own commit.
A branch with the same name and other changes stops the run with
`steering_import_branch_taken`.

A rerun starts at the first step not yet done.

The import branch is the one `steering/` branch that can change many
records. Its PR body carries a replaces block that maps each new record to
its old id. The stamp copies each old id into the ledger's `replaces` field,
and refuses with `replaces_unmatched` or `replaces_unreadable` when the block
does not match the records. Each record's id changes once, at this merge.

The conversion writes each v0.1 record to `steering/imported/<lineage>.md`
(`packages/oxagen/fixtures/steering-repo/v0.1/conversion.json`):

| v0.1 | v1 |
|---|---|
| `set_id` | dropped, and the set id becomes the lineage's prefix |
| `lineage_id` | `lineage`, without `ctx.<org>.` |
| `record_id`, `record_hash` | `id`, `hash`, computed again |
| `kind = "rule"` | `business-rule` or `code-rule`, chosen by a person |
| `statement` | the body |
| `sharing_scope` | `scope` |
| `provenance.source_kind`, `.source_uri` | `provenance.source`, `.uri` |
| `steering.force` | `force` |
| `constraint_effect` | `effect` |

## Earlier format

Before the steering repo, each record was a `context-record/v0.1` TOML file
under `.oxagen/rules/` in the workspace's bound repository. Six checks ran on
each Context PR, and Postgres held the ledger. A repository without
`steering/governance.toml` still uses that layout. The merge queue still
merges it, the sync mirrors its files into the Postgres registry, and
`lib/tacho-steering.ts` builds the policy bundle's `context.system` from that
registry. `oxagen pull`, `get_published_steering`, and `oxagen steering` read
only a committed `.oxagen/` tree. The migration above converts those files.
