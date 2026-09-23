# Repository binding, working copies, and the pull requests Oxagen opens

| | |
|---|---|
| **Status** | Spec, for build |
| **Date** | 2026-09-17 |
| **Surface** | `apps/app` · `apps/api` · `apps/mcp` · `apps/cli` · `packages/handlers` · `packages/oxagen` |
| **Design** | `macanderson/tmp-oxagen-mockups` → `mockups/pages/repositories.md`, `mockups/src/engine.js` → `pRepos()` / `wzInit()`; rendered in `mockups/missioncontrol.html#/a-intel/core-platform/repositories` |
| **Builds on** | ADR-043 (Oxagen governs, it does not run) · ADR-061 (Context PRs) · ADR-020 (the token chain) · MC spec §10 (the repository, steering and Context PRs), §11.2 (GitHub events and the code graph) · `docs/specs/steering/README.md` · `oxagen-roadmap:docs/oxagen/specs/oxagen-workspace-config/design.md` |
| **Job it serves** | `govern` — the mandate's Record clause. What is in force is what a named reviewer merged. |

## 1. The problem

Oxagen already governs one kind of file properly. A context record is authored in the
workspace's repository, proposed as a pull request, checked six ways, and published by a
merge — `open_context_pr` / `merge_context_pr` and the checks in
`packages/handlers/src/context.steering.checks.ts` are built, tested and bound to the
Steering page.

Everything around that lane is missing, and the gaps share one shape: **the product can
write a file into `.oxagen/` but cannot account for the directory it writes into.**

1. **Nothing puts `.oxagen/` in a repository.** The directory exists today only as a side
   effect of git creating a parent when `open_context_pr` writes the first record file.
   There is no template, no README, no initialise action.
2. **Nothing writes `.oxagen/rules/governance.toml`.** `context.steering.policy.ts` reads
   it on every open and every merge, and falls back to `team` when it is absent — but no
   code path in the monorepo writes it. A workspace's governance mode can be changed only
   by a human hand-editing a file in a repository. That is the single sharpest gap here:
   a control the product enforces on every merge and cannot set.
3. **Four of the six kinds of file have no pull-request path.** Records have the full
   lifecycle. Agent definitions have two unconnected halves: `commit_agent_definition`
   opens a pull request and nothing merges it, while `publish_agent_def` marks a version
   published in Postgres and sets it active without reference to any commit. So an agent
   definition can be in force in the product without the pull request carrying it ever
   merging — the exact inversion of the rule records follow.
   Skills have none (`list_skills` is observational telemetry). Tools have none, and
   `tool.import.ts` says so in a comment (ADR-072), and its stated blocker — "needs a bound
   repository, which no capability records" — is what §2.2 records. Workspace configuration
   has none.
4. **A local directory is invisible to the product.** `oxagen init`
   (`apps/cli/src/commands/init.ts`) writes `.oxagen/workspace.json` locally and reports
   nothing back, so nobody can see which machines hold the workspace's files, whether
   they are current, or whether Stella's symlinks are intact.
5. **`.oxagen/workspace.toml` is specified and unbuilt.** MC spec §10.1 says it declares
   linked repos, tool servers and budgets, and that Oxagen reconciles it against Postgres
   and reports drift. Nothing reads or writes it, and nothing reconciles.
6. **There is almost no UI for any of it.** `capability-ui-map.json` binds six steering
   capabilities and `bind_main_repository`, and nothing else in this area; the only
   repo-facing surface in `apps/app` is the onboarding bind-main-repo step. #3233 is
   landing the Workspace settings dialog that binds a **main** repo, which is the first
   half of one of the four tabs here (§6).

There is also a **file-name collision** waiting in the tree. MC spec §10.1 says the
committed configuration file is `.oxagen/workspace.toml`;
`oxagen-roadmap:docs/oxagen/specs/oxagen-workspace-config/design.md` specifies a CLI-local
`.oxagen/workspace.json` carrying the tenant link and resolved settings, and
`apps/cli/src/commands/workspace-link.ts` already writes it. Two files one name apart,
one reviewed and one not, and nothing today says which is which.

## 2. What this builds

One page, one wizard, two dialogs, and the capabilities behind them.

### 2.1 The decisions, before the mechanism

**`.oxagen/workspace.toml` is committed and is the source of truth.
`.oxagen/workspace.json` is gitignored and is this checkout's link.** The first says what
the workspace is — its repositories, its tool servers, its budgets — and changes only by a
pull request. The second says which workspace *this directory* talks to, which is a fact
about a laptop and not about the product, so it is never reviewed and never merged. The
init pull request adds the second to `.gitignore`. This resolves §1's collision in the one
place it can be resolved without a customer hitting it first.

**Drift is reported, never repaired in place.** The reconciler reads the file against the
control plane and opens a pull request per real difference. It never edits live state to
match the file, and never the file to match live state. A reconciler that silently edited
either side would make the file a description of the past and the product unreviewable —
the pull request is the only place a person can say which of the two was right.

**A working copy's state is never a run's state.** Steering reaches a run through the
gateway from the merged commit, whatever the directory on an operator's disk holds. A
stale working copy costs the *person*, who reads rules no longer in force. Every surface
that shows a working copy says this, because without it a yellow row reads as a governance
failure and somebody goes looking for a breach that did not happen.

**Linking a directory grants nothing.** A person's roles decide what they may do in the
app; an agent's mandate decides what it may do on the machine. A laptop is not a
principal, and pairing one must not be a path to authority.

**The GitHub App is read-write, and that is settled** (maintainer, 2026-09-18, on #3242).
It holds Contents read and write, Pull requests read and write, and Checks write, so Oxagen
can open a pull request, close one, and run the CI tasks a governed change needs. This was
Q1; it is no longer a question. `docs/specs/github-app/github-app-setup.md` said to keep
every permission read-only because "the connector never writes to GitHub" — true of the
ingestion connector, and never true of the product around it, which has been creating
branches and opening pull requests through installation tokens since ADR-061. That document
is corrected in the same change. What the write access still does not buy is unchanged:
Oxagen writes to a branch and never to the production branch, and it merges only what a
person merges.

**The governance mode is chosen once, by a person, in the init pull request**, and changed
afterwards the way everything else is. It is never a settings screen: a mode that a click
could raise is a mode a click could lower, and it is read on every merge.

### 2.2 The page

`/{org}/{ws}/repositories`, a Workspace nav item between Steering and Spend. Four tabs.
`mockups/pages/repositories.md` is the binding spec for layout, copy and every state; this
document does not repeat it.

| Tab | Holds | Capabilities |
|---|---|---|
| Repositories | main, linked and reachable-but-unbound, with production branch and `.oxagen/` state | `list_repository_bindings`, `get_repository_binding`, `link_repository`, `set_main_repository` |
| Working copies | the same tree on a machine: sync state, symlinks, bundle version | `list_working_copies`, `pair_working_copy`, `report_working_copy` |
| Changes | every open pull request across all six kinds of file | `list_oxagen_prs`, `get_oxagen_pr`, `merge_oxagen_pr` |
| Configuration | `workspace.toml` beside live state, drift, `governance.toml` | `get_workspace_config`, `list_config_drift`, `open_reconcile_pr` |

### 2.3 The init wizard

`init_oxagen_directory` — five steps in the app (Repository → Branch & governance →
Permissions → Review → Pull request), one capability at the end. It opens a pull request on
branch `oxagen/init` carrying:

```
.oxagen/workspace.toml            # schema = "oxagen-workspace/v0.1"
.oxagen/rules/governance.toml     # mode = solo | team | regulated
.oxagen/rules/.gitkeep
.oxagen/proposals/.gitkeep
.oxagen/agents/.gitkeep
.gitignore                        # + .stella/private/ and .oxagen/workspace.json
```

Five checks, mirrored as GitHub check runs on the head commit, in the shape
`context.steering.checks.ts` already established (one at a time, each persisted before the
next starts, each read from the file at the head rather than from the text that was built):

| # | name | passes when | fails when |
|---|---|---|---|
| 1 | `schema` | `workspace.toml` parses and every repository it declares resolves through this installation | a declared repository the installation cannot reach, named |
| 2 | `layout` | no `.oxagen/` exists on the production branch; only the six paths above changed | a tree already there (refuse, never merge into it); any other changed path, named |
| 3 | `governance` | `mode` is one of the three | a file that parses and names no mode — refused now rather than refusing every later pull request |
| 4 | `secret_pii_scan` | nothing found by `findSecretsAndPii` over every added file | any finding, named by file and field |
| 5 | `no_authority` | nothing added grants a tool, raises a tier or lifts a budget | any grant-shaped declaration |

The permissions step is not decoration. The installation holds Contents read **and write**,
Pull requests read **and write**, and Checks **write** (§2.1), and this is the one screen in
the product where a person sees that stated before Oxagen first writes to their repository.
It says what that access buys — a branch, a file, a pull request, a check run — beside what
it does not: no push to the production branch, no merge without a person, no secret in the
tree, no grant of authority.

### 2.4 Connecting a directory

`oxagen init` already resolves org and workspace, writes `.oxagen/workspace.json`, and
offers to create a GitHub connection. This adds one thing: it tells the control plane the
directory exists.

There is no browse button in the app, and there must not be one: a browser cannot see a
filesystem, and a path typed into a web form proves nothing about what is at it. The
directory identifies itself. The app shows a pairing code; the CLI sends it with facts the
machine read — the git remote, the branch, the head, whether `.oxagen/` is present, whether
the Stella symlinks resolve. The code authorises the pairing once and expires; what
identifies the copy afterwards is the machine's existing enrollment (`tacho`), so a code
that leaks after it is spent links nothing.

Afterwards `oxagen status` and `oxagen pull` keep the row current.

## 3. Capabilities

All new contracts follow ADR-025 verb-first snake_case, and the parity rule (contract →
API route → MCP tool → CLI command → UI binding). Where a capability gates on an
org/workspace role, it declares `api` only and no MCP or CLI surface — the same reasoning
`open_context_pr` already carries: an API key holds no user, so a role check would have
nothing to check.

| name | surfaces | mutates | roles | notes |
|---|---|---|---|---|
| `list_repository_bindings` | api, mcp, agent | no | ws Viewer+ | main, linked, and reachable-unbound in one list; composed from #3233's `get_main_repository` and `list_installation_repositories`, not a second read of GitHub |
| `get_repository_binding` | api, mcp | no | ws Viewer+ | `.oxagen/` presence, file count and commit; resolves **through the head**, never by joining the binding table (§6) |
| `link_repository` | api | yes | org Owner/Admin | role `linked`; confirms the production branch |
| `set_main_repository` | api | yes | org Owner | `requiresApproval`, writes a security event |
| `init_oxagen_directory` | api | yes | org Owner/Admin | opens the init pull request |
| `list_oxagen_prs` | api, mcp | no | ws Viewer+ | every kind, one shape |
| `get_oxagen_pr` | api, mcp | no | ws Viewer+ | files, checks, what merge will do |
| `open_oxagen_pr` | api | yes | ws Owner/Member | the generalisation of `open_context_pr`: branch, commit, open, run the checks |
| `merge_oxagen_pr` | api | yes | ws Owner/Member | the generalisation of `merge_context_pr` |
| `close_oxagen_pr` | api | yes | ws Owner/Member | the generalisation of `dismiss_proposal`: close, delete the branch, publish nothing |
| `pair_working_copy` | api | yes | ws Member+ | mints the pairing code |
| `report_working_copy` | api | yes | agent key | the CLI's callback; carries no authority |
| `list_working_copies` | api, mcp | no | ws Viewer+ | |
| `get_workspace_config` | api, mcp, agent | no | ws Viewer+ | reads `workspace.toml` at the production head |
| `list_config_drift` | api, mcp | no | ws Viewer+ | the file against live state |
| `open_reconcile_pr` | api | yes | org Owner/Admin | one pull request per real difference |

`merge_oxagen_pr` is where this pays for itself. `merge_context_pr` already re-reads
`governance.toml` at merge time, refuses a moved head or a moved base, merges pinned to the
checked commit, resumes from an already-merged commit, deletes the branch, publishes, and
appends the promotion event. **That is the whole lifecycle, and it is record-shaped only in
its last step.** `merge_oxagen_pr` lifts the first eight into a kind-agnostic merge and
dispatches publication by kind — which is also what joins `commit_agent_definition`'s
branch to `publish_agent_def`'s row, so that an agent version becomes active because a
commit merged rather than in spite of one.

**One lifecycle, three verbs, four kinds.** A governed file is opened, checked, and then
either merged or closed, and every one of those steps is the same for a skill, an agent
definition, a context record and a tool. `open_oxagen_pr` generalises `open_context_pr`
(branch from the production head, commit the file, open the pull request, run the checks
one at a time against the file read back at the head, mirror each as a check run).
`close_oxagen_pr` generalises `dismiss_proposal` (close the pull request, delete the head
branch, publish nothing) and is the only way to withdraw a change that has not merged —
taking something back out of force after it has merged is its own pull request, never a
close. Only publication differs by kind, so the kind is a dispatch argument and not a
second implementation.

## 4. Data

- **Postgres.** `ingestion.repository_bindings` is **immutable, append-only and versioned**
  with a supersession chain, and `repository_binding_heads` is the explicitly mutable
  pointer at the current version (see the schema comments on both). So nothing this spec
  adds goes on the binding: `production_branch` is already `configured_default_ref` there,
  and `.oxagen/` presence and its commit change on every push, which on an append-only
  evidence table would mint a binding version per push and make "a version means a rename
  or a default-ref reconfiguration" false. A first draft of this section proposed adding
  `role`, `production_branch`, `oxagen_state` and `oxagen_commit` to the binding; that was
  wrong, and the mistake is the one the table's own comment exists to prevent.
  Instead: `role` (`main` | `linked`) joins the **head**, which is already keyed per
  workspace and is where a per-workspace fact belongs; `.oxagen/` presence, file count and
  commit go in a separate `oxagen_tree_observations` row per (workspace, repository),
  overwritten on each read, because it is a cache of what a branch looked like and not
  evidence any run was admitted against. New `working_copies`
  (org, ws, enrollment, machine, path, remote, branch, head, oxagen_state, symlinks_ok,
  bundle_version, last_seen_at); new `oxagen_pull_requests` (org, ws, repo, kind, branch,
  number, state, head_sha, opened_by_user_id, opened_by_kind) with the same
  one-open-per-lineage index shape `context_proposals_open_pr_idx` uses, keyed per kind.
- **Git** is the source of truth for everything in `.oxagen/`. Postgres mirrors it and is
  re-read from the merged commit; a mismatch is a `steering_drift` incident, exactly as
  §10.2 already specifies for records.
- **ClickHouse** observes: `oxagen_pr.opened`, `.checked`, `.merged`, `workcopy.paired`,
  `.reported`, `config.drift_detected`.
- **Neo4j**: unchanged. None of this is graph data.

## 5. Phases

Each phase is shippable and leaves the gate green.

1. **The lifecycle generalisation.** Lift `open_context_pr`'s and `merge_context_pr`'s
   kind-agnostic bodies into `open_oxagen_pr`, `merge_oxagen_pr` and `close_oxagen_pr`;
   the three context capabilities become thin callers. Give `commit_agent_definition` its
   merge and its close, and make `publish_agent_def` a consequence of that merge rather
   than a parallel path to the same state. No UI. This is the highest-value phase and the
   only one that fixes an existing inversion rather than adding surface.
2. **The four kinds on that lane.** Register the skill and tool kinds against it —
   `.oxagen/skills/<name>/SKILL.md` and `.oxagen/tools/<name>.toml`, with their own
   publication step and their own checks, and nothing else new. With records and agent
   definitions already on it from phase 1, opening and closing a pull request works for
   all four kinds here rather than at the end (ADR-072; decided on #3242).
3. **Bindings and the page shell**, on top of #3233 rather than beside it (§8).
   `link_repository` (role `linked`, which #3233 does not cover) and
   `set_main_repository` (the org-owner rebind #3233 names and deliberately leaves);
   `list_repository_bindings` composed from #3233's `get_main_repository` and
   `list_installation_repositories` rather than re-reading GitHub; the `.oxagen/` presence
   read and its observation row; the page with the Repositories tab. Reads from
   `features/**` follow ADR-089.
4. **The init wizard.** `init_oxagen_directory` and its five checks. Closes the
   `governance.toml` gap.
5. **Changes.** `list_oxagen_prs` / `get_oxagen_pr`; the Changes tab over every kind,
   with Merge and Close on the selected pull request.
6. **Working copies.** `pair_working_copy`, `report_working_copy`,
   `list_working_copies`; `oxagen init --pair`, `oxagen status`, `oxagen pull`.
7. **Configuration and drift.** `get_workspace_config`, `list_config_drift`,
   `open_reconcile_pr`, the reconciler job.

**Not in scope.** Ontology pull requests (`v2/propose_ontology_version` is an inert
descriptor). The `oxagen config` interview from
`oxagen-roadmap:docs/oxagen/specs/oxagen-workspace-config/design.md` phases 4–6 — that document's `workspace.json`
is the gitignored local file, and §2.1 fixes which is which, but its resolver and interview
agent are their own body of work.

## 6. What #3233 already builds, and what is left

[#3233](https://github.com/macanderson/oxagen/pull/3233) ("a Workspace settings dialog that
binds a main repository") is in flight and lands the first half of §2.2's Repositories tab.
This spec builds on it and must not duplicate it.

| | #3233 | this spec |
|---|---|---|
| `get_main_repository` | the bound main repo, whether an installation is attached, whether the connection is live, the three URLs | consumed, not replaced |
| `list_installation_repositories` | the repositories the installation can reach | the source of the Repositories tab's "not linked" rows |
| `list_github_installations` / `attach_github_installation` | the install leg | unchanged |
| binding a **main** repo | the settings dialog | unchanged |
| binding a **linked** repo | not covered | `link_repository` |
| changing which repo is main | deliberately absent; the dialog says so and the contract refuses `main_repo_bound` | `set_main_repository`, org Owner, `requiresApproval`, security event |
| `.oxagen/` presence per repository | not read | the observation row in §4 |

Two things #3233 surfaces that this spec inherits rather than re-discovers. Its round-2 P1
shows that a replaced connection orphans a binding unless the successor moves the head, so
anything here reading a binding reads it **through the head**, never by joining the
binding table directly. And its own post-mortem names the structural cause of four of its
eight P1s: `apps/api/src/routes/v1/github-oauth.ts` bypasses the kernel, so every gate the
kernel would apply is hand-rolled there. No capability in §3 may take that route; each one
goes through `invoke()`.
[#3253](https://github.com/macanderson/oxagen/issues/3253) carries the open invariant that
the bound repository and the credential acting on it are resolved by independent reads —
`open_oxagen_pr` must not add a third such read.

## 7. Open questions

| # | Question | Blocks | Recommendation |
|---|---|---|---|
| Q2 | One `oxagen_pull_requests` table, or per-kind tables? | 1, 5 | One. The lifecycle is identical for all six kinds and only publication differs; two tables would duplicate the head/base/checks invariants that `context.pr.open.ts` got right once. |
| Q3 | Do the two overlapping record generations (`publish_context_record` / `promote_context_record` vs `merge_context_pr` / `list_records`) get reconciled here? | none | No — name it in the ADR and leave it. It is a real problem and it is not this one. |
| Q4 | Does `set_main_repository` reuse the existing approval machinery or get its own? | 2 | Reuse. `requiresApproval: true` on the contract, as `open_context_pr` and `merge_context_pr` already do. |

## 8. Decisions that need an ADR

- **ADR: `.oxagen/workspace.toml` is committed; `.oxagen/workspace.json` is local.** §2.1.
  Two specs currently imply different things about the same directory, and one of them is
  already written by shipped CLI code.
- **ADR: one pull-request lifecycle for every governed file.** §3, the `merge_oxagen_pr`
  generalisation, and why agent definitions were stranded without it.
