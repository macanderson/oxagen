# Repository binding

| | |
|---|---|
| **Status** | Spec, describes `main` at 3527edbef |
| **Date** | 2026-09-27 (first written 2026-09-17) |
| **Surface** | `apps/app`, `apps/api`, `apps/mcp`, `apps/cli`, `packages/handlers`, `packages/oxagen` |
| **Design** | `mockups/pages/repositories.md` in `macanderson/tmp-oxagen-mockups` |
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
| 1 | `pick_connection` | Picks the organization's Oxagen Steering installation or GitLab group. It asks only when there is more than one. |
| 2 | `create_repository` | Creates the private repository `oxagen-<slug>`, then tries `-2`, `-3`, and so on, up to 20 attempts. |
| 3 | `add_to_installation` | GitHub only. Uses the owner's user token to add the new repository to the installation. |
| 4 | `write_first_commit` | Commits "Seed the steering repo" to `main`. |
| 5 | `apply_settings` | Applies the prescribed settings, then reads them back and compares. |
| 6 | `publish_version` | Publishes version 1 and records a deployment to the `steering` environment. |
| 7 | `bind_repository` | Workspace only. Writes a head with role `steering`. |

`create_workspace` (`workspace.create.ts`), the organization create, and the
GitHub OAuth callback start the job with `steering-repo/provision.requested`.
Every step is safe to repeat. The job keeps its state in the `steering_repo`
key of the workspace's settings, or of the organization's for `<org>/oxagen`.
A rerun adopts what an earlier run made. A failed step records its name and
error, and the job retries from that step.

Creating an organization runs the same steps for `<org>/oxagen`, which holds
organization records. That repository has no `workspace.toml` and no head.

PR #4600 adds a GitLab-only `register_webhook` step between steps 5 and 6.

### 2.2 Credentials

Two GitHub apps split the permissions:

- **Oxagen Steering** creates the steering repos and holds admin only on the
  repositories Oxagen creates.
- **Oxagen** reads and checks your code repositories, with the permissions it
  had before.

GitHub does not add a repository an app creates to an installation limited
to selected repositories. So an organization owner authorizes Oxagen Steering
once, and step 3 uses that token only to add each new steering repo to the
installation.

On GitLab, an organization Owner or Admin connects a group with a group
access token that has the `api` scope and the Maintainer role
(`POST /v1/:org_slug/connections/steering/gitlab`). Oxagen stores it under the
provider `gitlab_steering`, and step 1 offers the group.

The steering repo's credential stays with Oxagen. Oxagen reads and writes a
provisioned steering repo server-side through the Oxagen Steering
installation (`mintSteeringInstallationToken`), and no agent receives that
token. `create_github_token` for the steering repo hands out the workspace
installation's token only when that installation covers the repository.
Otherwise it refuses with `steering_repo_propose_only`, and the agent changes
the steering repo through a steering PR.

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

The spec gives linked repositories one check, named `Oxagen`, posted from
outside the repository. `names.ts` defines `CODE_REPOSITORY_CHECK_NAME`, and
no code posts it yet.

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
| `bind_main_repository` | api | Writes a `steering` head with no steering PR. Refuses `main_repo_bound` when the workspace already has a different steering repo. Pending removal (§8). |
| `attach_gitlab_project` | api | Attaches a GitLab project with a project access token (#3762). |

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

## 8. Pending S8 change

Issue #4616 removes `bind_main_repository`, the app's bind controls, and the
provisional first workspace (ADR-065) once Mac approves.
