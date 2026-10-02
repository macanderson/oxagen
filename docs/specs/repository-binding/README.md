# Repository binding

| | |
|---|---|
| **Status** | Spec, describes `main` at 3527edbef, and §3.5 the code repository check of #5058 |
| **Date** | 2026-10-02 (first written 2026-09-17) |
| **Surface** | `apps/app`, `apps/api`, `apps/mcp`, `apps/cli`, `packages/handlers`, `packages/oxagen` |
| **Design** | `mockups/pages/repositories.md` in `oxageninc/roadmap` |
| **Builds on** | ADR-212 (a workspace links a code repository by a steering PR), ADR-073 (an API key names a workspace), ADR-020 (the token chain), ADR-043 (Oxagen governs and does not run), `docs/specs/steering/README.md` |
| **Job it serves** | `govern`, the mandate's Record clause: what is in force is what a named reviewer merged. |

## 1. Two roles

A workspace binds repositories in two roles. The role lives on the head,
`ingestion.repository_binding_heads.role`:

| Role | What it is | How many | Who creates the head |
|---|---|---|---|
| `steering` | The workspace's steering repo, which holds its steering records | One per workspace. No other workspace can bind it. | The provisioning job, when you create the workspace |
| `linked` | A code repository the workspace's agents work in | Any number. One code repository can be linked to many workspaces. | The steering sync, after a steering PR that lists it merges |

Migration 20260927185600 moved every earlier `main` head. In each workspace,
an existing `steering` head, or else the oldest `main` head, became
`steering`. Every other `main` head became `linked`. The role check now
admits `steering` and `linked` only. The unique index and the trigger that
keep `steering` exclusive kept their names, and the handlers map them to
`main_repo_claimed`.

The public contracts keep their earlier names (ADR-212, decision 2). They
still answer `role: "main" | "linked"` and the `main_repo_*` reason codes, and
`get_main_repository` answers the steering repo. New code and copy say
"steering repo", "steering record", and "steering PR".

`ingestion.repository_bindings` stays immutable and append-only, with a
supersession chain. The head is the mutable pointer at its current version,
and the role belongs on the head because it is a per-workspace fact. Every
read of a binding goes through the head and not the binding table,
because a replaced connection orphans a binding unless the successor
moves the head (#3233).

## 2. The steering repo

### 2.1 Provisioning

Creating a workspace creates its steering repo. The durable job
`steering-repo/provision` (`packages/handlers/src/steering_repo.provision.ts`,
lane S1, #4450) runs seven steps, one at a time:

| # | Step | What it does |
|---|---|---|
| 1 | `pick_connection` | Picks the organization's Oxagen GitHub App installation or GitLab group. It asks only when there is more than one. |
| 2 | `create_repository` | Creates the private repository `oxagen-<slug>`, then tries `-2`, `-3`, and so on, up to 20 attempts. |
| 3 | `add_to_installation` | GitHub only. Uses the owner's user token to add the new repository to the installation. |
| 4 | `write_first_commit` | Commits "Seed the steering repo" to `main`. |
| 5 | `apply_settings` | Applies the prescribed settings, then reads them back and compares. |
| 6 | `register_webhook` | GitLab only. Adds a project hook that sends push and merge request events to Oxagen. A URL GitLab refuses logs a warning and does not stop the run. |
| 7 | `publish_version` | Records version 1 as a deployment to the `steering` environment. |
| 8 | `bind_repository` | Workspace only. Writes a head with role `steering`, then publishes the first commit through the version store as version 1, so the first steering PR publishes version 2 (#4732). |

`create_workspace` (`workspace.create.ts`), the organization create, and the
GitHub OAuth callback start the job with `steering-repo/provision.requested`.
Every step is safe to repeat. The job keeps its state in the `steering_repo`
key of the workspace's settings, or of the organization's for `<org>/oxagen-config`.
A rerun adopts what an earlier run made. A failed step records its name and
error, and the job retries from that step.

Creating an organization runs the same steps for `<org>/oxagen-config`, which holds
organization records. That repository has no `workspace.toml` and no head.

PR #4600 adds a GitLab-only `register_webhook` step between steps 5 and 6.

### 2.2 Credentials

One GitHub App, Oxagen, reads and checks your code repositories and creates
the steering repos (ADR-228). It holds Administration and Deployments write
for the steering repos, and that access reaches every repository its
installation covers.

GitHub does not add a repository an app creates to an installation limited
to selected repositories. So an organization owner authorizes the Oxagen
GitHub App once, and step 3 uses that token only to add each new steering
repo to the installation.

On GitLab, an organization Owner or Admin connects a group with a group
access token that has the `api` scope and the Maintainer role
(`POST /v1/:org_slug/connections/steering/gitlab`). Oxagen stores it under the
provider `gitlab_steering`, and step 1 offers the group.

The steering repo's credential stays with Oxagen. Oxagen reads and writes a
provisioned steering repo server-side through an installation token of the
Oxagen GitHub App (`mintSteeringInstallationToken`), and no agent receives
that token. `create_github_token` refuses the steering repo with
`steering_repo_propose_only`, and the agent changes the steering repo through
a steering PR (ADR-228).

### 2.3 Changes to the steering repo

Every change is a steering PR, and Oxagen merges it. The steering
spec covers branch names, checks, approval, the stamp, the ledger, and
publishing. Each steering repo's `steering/governance.toml` sets its review
mode, and a new repository starts in `solo`.

## 3. Linked repositories

### 3.1 Linking

`workspace.toml` in the steering repo is the record of which code
repositories a workspace links. Each entry is one `[[repositories]]` table
with a `url` such as `github.com/a-intel/platform`.

`link_repository` (`packages/handlers/src/repository.link.ts`) writes no
head. It takes four steps:

1. It checks the caller's role: an org Owner or Admin, or the workspace's
   Owner.
2. It runs the checks the head write runs (`repository.link.write.ts`): the
   installation, whether the installation can see the repository, another
   workspace's steering claim, and this workspace's heads. So it refuses a
   steering PR that could not take effect before it opens one.
3. It reads `workspace.toml` on the steering repo's `main`:
   - The file lists the repository already. It answers `status: "listed"`
     and opens nothing. The next sync writes the head.
   - The file is missing. The steering PR creates it with this one entry.
   - The file reads as `workspace/v1`. The steering PR appends the entry.
   - The file names another schema, or does not read as `workspace/v1`. It
     refuses with `conflict: workspace_toml_unreadable`.
4. It opens the steering PR from `workspace/link-<owner>-<name>-<hash>` and
   answers `status: "proposed"`. A second call reuses the branch and the PR.

A link takes effect when its steering PR merges and the next sync runs. The
Repositories page, the run page, and `oxagen repo link` show the steering PR
and say "Merge the steering PR to finish linking."

Only GitHub repositories link. An entry on another host becomes a warning.

### 3.2 Unlinking

`unlink_repository` (`packages/handlers/src/repository.unlink.ts`) has the
same role gate. It refuses the steering head with
`conflict: main_repo_unlink_refused`. For a linked head, `workspace.toml`
decides:

- The file lists the repository. A steering PR from
  `workspace/unlink-<owner>-<name>-<hash>` removes the entry, and the head
  stays until it merges. It answers `status: "proposed"`.
- The file does not list it. The link predates the steering record, so the
  handler deletes the head at once and answers `status: "unlinked"`.

Only the head goes. The binding versions stay, because admitted runs cite
them.

### 3.3 The sync

Step 5 of the steering sync (`context.steering.sync.ts`, ADR-184) reads
`workspace.toml` whenever the synced head moves. It calls
`repository.link.reconcile.ts` with the list the prior head held and the list
the new head holds:

- It writes a `linked` head for each listed repository that has none.
- It deletes a `linked` head only when the prior list named it and the new
  list does not.
- It deletes nothing when it cannot tell what the prior list held, when the
  file is missing, or when the file does not read as `workspace/v1`.
- A repository it cannot link becomes one warning with code
  `repository_link`, and the sync still succeeds.

A person who edits `workspace.toml` by hand in a steering PR links or unlinks
the same way.

### 3.4 Runs and workspaces

The key a host enrolled with names the session's workspace (ADR-073). The
repository a session runs in does not pick its workspace or its scope.

A run in a repository its workspace does not link still runs, and Oxagen
charges its cost to that workspace. Ingest sets
`tacho.sessions.repository_unlinked` on the session's first row (migration
20260928001500), and `get_run` and `get_tacho_session` answer it. A session
recorded before that migration reads `false`.

Enrollment reads the host's git remote only to suggest a repository on the
onboarding screen.

### 3.5 Code repository check

Every pull request in a linked repository gets one check, named `Oxagen`
(`CODE_REPOSITORY_CHECK_NAME` in `names.ts`). Oxagen posts it from outside
the repository, so no workflow file is committed there. On GitHub it is a
check run from the Oxagen GitHub App. On GitLab it is a commit status, posted
with the project's stored access token. The code is in
`packages/handlers/src/code-repo-check/` (S2b, #5058).

**Routing.** The GitHub App webhook (`apps/api/src/routes/v1/github-webhook.ts`)
reads each `pull_request` delivery that opens, reopens, or moves a pull
request. It finds every workspace with a `linked` head for the repository and
sends one `code-repo/check.requested` event per workspace. A repository that
any workspace holds as its steering repo gets no event, because its pull
requests are steering PRs and carry the `Oxagen steering` check. A GitLab
merge request goes through `gitlab.webhook.ts` the same way, for the one
workspace the connection belongs to. The event's id names the head and base
commits, so a redelivered webhook runs the check once. The durable job is
`code-repo/check` in `packages/inngest-functions`.

**What it reads.** The check lists the files the pull request changes and
keeps the harness instruction files: `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`
at any depth, `.cursorrules`, `.cursor/rules/`, `.github/copilot-instructions.md`,
`.github/instructions/*.instructions.md`, `.windsurfrules`, `.windsurf/rules/`,
and `.clinerules`. It reads each file at the base and at the head, and keeps
the list items and paragraphs the head adds. A renamed file is read at its
old path at the base, so a move adds nothing. Headings, code blocks, tables,
comments, and frontmatter are skipped.

**Findings.** Each added statement is compared with the workspace's active
steering records, using the steering conflicts check's own test
(`similarStatements` in `@oxagen/steering-check`). No model is called.

| Finding | When |
|---|---|
| Repeat | The line has the same words as a record, or shares 90 percent of them when both have at least eight distinct words. A line that says the same thing with other force words, such as "You must" where the record says "Always", is a repeat too. |
| Contradiction | The line and a record say the same thing with opposite effects. A line with "never", "do not", "must not", "avoid", or the like forbids, and any other line requires. A constraint record keeps its published effect. |

Records and lines are compared whole and sentence by sentence.

**Memories.** Each added statement that is neither a repeat nor a
contradiction goes to S6's memory capture (`ingestMemories`, capture
`pull_request`). The pull request's URL is the source, and the evidence is the
pull request and the line at the head commit. A second push to the pull
request stores no second copy. A memory waits for the curator and a person,
as every memory does.

**Conclusion.** The check warns by default. On GitHub a finding makes it
neutral, which a required check still passes. On GitLab, which has no neutral
status, a warning posts success and its description counts the findings. A
finding fails the check only when the workspace's published `workspace.toml`
sets `block_merge = true` under `[code_checks]`. The check reads that file at
the commit of the published steering version. A workspace with no published
version, or a file that does not read as `workspace/v1`, warns. The check
blocks a merge only once the customer makes `Oxagen` a required check in the
repository's branch rules.

**Limits.** A repository linked by several workspaces gets one `Oxagen` check
from each, because each workspace's records stay in its own tenant scope. One
check reads at most 20 instruction files and compares at most 500 statements,
and hands at most 50 memories to capture. GitHub lists at most 300 changed
files, so an instruction file past that is not read. On GitHub the base text
is read at the base branch's commit that the delivery names, not at the
merge base. So a line the base branch removed after the pull request
branched, which the head still holds, reads as added.

**Stored findings (ADR-253).** The check stores each statement it flags in
`agent.code_repository_findings`: the repository, the pull request, the
commit it read, the file, the line, and the text. Each run replaces its pull
request's rows. A pull request closed without merging deletes them. A merged
one keeps them, and its merge deletes the merged rows of earlier pull requests
whose statement the files it touched no longer hold at the merge commit.
`list_code_repository_findings` compares the stored statements with the
workspace's active records on every read, so a record revised or retired since
the check ran changes the answer. `promote_instruction_to_steering` turns a
contradiction into a proposal for the record it contradicts and opens that
proposal's steering PR.

## 4. `.oxagen/` in a code checkout

A code repository holds no committed steering. In a checkout, `.oxagen/`
holds up to three machine-local files:

| File | What it holds | Committed |
|---|---|---|
| `workspace.json` | This checkout's link to one workspace, written by `oxagen init` | No. `oxagen init` adds it to `.gitignore`. |
| `settings.json` | Project settings that `@oxagen/mcp-config` and the `oxagen steering` gates read | When the project shares it |
| `settings.local.json` | One person's overrides of those gates | No |

`workspace.json` is one person's choice for one checkout. It scopes that
person's CLI calls. It does not scope a wrapped session.

A repository that used to hold `.oxagen/` steering loses its committed
steering files in one pull request during the workspace migration. The
machine-local files above stay.

Three commands still expect a committed `.oxagen/` tree. `oxagen pull` and
`get_published_steering` read `.oxagen/` at the steering repo's head, and
`oxagen steering` compares the checkout's `.oxagen/` with it. A steering repo
in the current layout has no `.oxagen/`, so for a moved workspace they find
nothing.

## 5. Capabilities

| Name | Surfaces | Notes |
|---|---|---|
| `get_main_repository` | api, mcp | Answers the steering repo. |
| `list_installation_repositories` | api, mcp | The repositories the installation reaches. |
| `list_repositories` | api, mcp, cli | The workspace's repositories. |
| `get_repository_tree` | api, mcp, cli | A repository's tree at a ref. |
| `link_repository` | api, mcp, cli | Opens a steering PR (§3.1). The CLI command is `oxagen repo link`. |
| `unlink_repository` | api, mcp, cli | Opens a steering PR, or deletes a head that predates the record (§3.2). |
| `set_governance_mode` | api, mcp, cli | Opens a steering PR that changes `governance.toml`. |
| `list_working_copies` | api, mcp | The checkouts a CLI reported. |
| `record_working_copy` | api, cli | The CLI's report of one checkout. |
| `create_github_token` | api | Refuses the steering repo with `steering_repo_propose_only` (§2.2). |
| `open_init_pr` | api, mcp, cli | Retired. It refuses with `conflict: init_pr_retired`. |
| `attach_gitlab_project` | api | Attaches a GitLab project with a project access token (#3762). |
| `list_code_repository_findings` | api, mcp, cli | The stored instruction-file statements that repeat or contradict a record today (§3.5, ADR-253). The CLI command is `oxagen steering findings`. |
| `promote_instruction_to_steering` | api, mcp, cli | Proposes a contradicted record with the statement as its text, and opens its steering PR (§3.5). The CLI command is `oxagen steering promote`. |

`link_repository` and `unlink_repository` take an org Owner or Admin, or the
workspace's Owner. Each capability follows ADR-025's verb-first snake_case
and the parity rule: contract, API route, MCP tool, CLI command, and UI
binding.

## 6. The Repositories page

`/{org}/{ws}/repositories` has four tabs: Repositories, Working copies,
Changes, and Configuration (`apps/app/src/features/repositories/`).

- **Repositories** lists the steering repo, the linked repositories, and the
  repositories the installation reaches that the workspace does not link.
  Link and Unlink open steering PRs.
- **Working copies** lists the checkouts a CLI reported.
- **Changes** and **Configuration** name their backend gaps in `gaps.ts`,
  tracked in #3241.

The page still mounts the earlier init wizard (`init-wizard.tsx`). Its bind
and link steps work. Its last step calls `open_init_pr`, which now refuses
with `init_pr_retired`, because the steering repo replaces the init pull
request.

## 7. Data

- **Postgres.** `ingestion.repository_bindings` holds binding versions.
  `ingestion.repository_binding_heads` points at the current one per
  workspace and carries `role`. The provisioning state lives in the
  `steering_repo` settings key. Published steering versions live in the
  version store, keyed by `<host>/<owner>/<name>`.
  `tacho.sessions.repository_unlinked` flags unlinked runs.
- **Git.** The steering repo is the source of truth for steering records,
  governance, and the list of linked repositories. Postgres mirrors it.
- **Neo4j.** Unchanged. None of this is graph data.

## 8. S8 removal

PR #4647 (issue #4616) removed `bind_main_repository`, the app's bind
controls, and the provisional first workspace (ADR-065).
