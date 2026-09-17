# Repository binding, working copies, and the pull requests Oxagen opens

| | |
|---|---|
| **Status** | Spec, for build |
| **Date** | 2026-09-17 |
| **Surface** | `apps/app` · `apps/api` · `apps/mcp` · `apps/cli` · `packages/handlers` · `packages/oxagen` |
| **Design** | `macanderson/tmp-oxagen-mockups` → `mockups/pages/repositories.md`, `mockups/src/engine.js` → `pRepos()` / `wzInit()`; rendered in `mockups/missioncontrol.html#/a-intel/core-platform/repositories` |
| **Builds on** | ADR-043 (Oxagen governs, it does not run) · ADR-061 (Context PRs) · ADR-020 (the token chain) · MC spec §10 (the repository, steering and Context PRs), §11.2 (GitHub events and the code graph) · `docs/specs/steering/README.md` · `docs/specs/oxagen-workspace-config/design.md` |
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
   lifecycle. Agent definitions have `commit_agent_definition`, which opens a pull request
   and has **no merge capability** — an asymmetry that leaves them stranded on a branch.
   Skills have none (`list_skills` is observational telemetry). Tools have none, and
   `tool.import.ts` says so in a comment (ADR-072). Workspace configuration has none.
4. **A local directory is invisible to the product.** `oxagen init`
   (`apps/cli/src/commands/init.ts`) writes `.oxagen/workspace.json` locally and reports
   nothing back, so nobody can see which machines hold the workspace's files, whether
   they are current, or whether Stella's symlinks are intact.
5. **`.oxagen/workspace.toml` is specified and unbuilt.** MC spec §10.1 says it declares
   linked repos, tool servers and budgets, and that Oxagen reconciles it against Postgres
   and reports drift. Nothing reads or writes it, and nothing reconciles.
6. **There is no UI for any of it.** The only repo-facing surface in `apps/app` is the
   onboarding bind-main-repo step. `capability-ui-map.json` binds six steering
   capabilities and `bind_main_repository`, and nothing else in this area.

There is also a **file-name collision** waiting in the tree. MC spec §10.1 says the
committed configuration file is `.oxagen/workspace.toml`;
`docs/specs/oxagen-workspace-config/design.md` specifies a CLI-local
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

The permissions step is not decoration. **The documented GitHub App permission set is
read-only** (`docs/specs/github-app/github-app-setup.md`: "the connector never writes to
GitHub"), while this lifecycle writes branches, files, pull requests and check runs. The
step states what the installation must hold — Contents read **and write**, Pull requests
read **and write**, Checks **write** — and §5 tracks reconciling the documented set with
what the code already does.

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
| `list_repository_bindings` | api, mcp, agent | no | ws Viewer+ | main, linked, and reachable-unbound in one list |
| `get_repository_binding` | api, mcp | no | ws Viewer+ | includes `.oxagen/` presence, file count and commit |
| `link_repository` | api | yes | org Owner/Admin | role `linked`; confirms the production branch |
| `set_main_repository` | api | yes | org Owner | `requiresApproval`, writes a security event |
| `init_oxagen_directory` | api | yes | org Owner/Admin | opens the init pull request |
| `list_oxagen_prs` | api, mcp | no | ws Viewer+ | every kind, one shape |
| `get_oxagen_pr` | api, mcp | no | ws Viewer+ | files, checks, what merge will do |
| `merge_oxagen_pr` | api | yes | ws Owner/Member | the generalisation of `merge_context_pr` |
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
dispatches publication by kind — which is also what finally gives
`commit_agent_definition` a merge.

## 4. Data

- **Postgres** (`ingestion` / a new `oxagen` schema): `repository_bindings` gains
  `role`, `production_branch`, `oxagen_state`, `oxagen_commit`; new `working_copies`
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

1. **The merge generalisation.** Lift `merge_context_pr`'s kind-agnostic body into
   `merge_oxagen_pr`; `merge_context_pr` becomes a thin caller. Give
   `commit_agent_definition` its merge. No UI. This is the highest-value phase and the
   only one that fixes an existing asymmetry rather than adding surface.
2. **Bindings and the page shell.** `list_repository_bindings`, `get_repository_binding`,
   `link_repository`, `set_main_repository`; the page with the Repositories tab; the
   `.oxagen/` presence read.
3. **The init wizard.** `init_oxagen_directory` and its five checks. Closes the
   `governance.toml` gap.
4. **Changes.** `list_oxagen_prs` / `get_oxagen_pr`; the Changes tab over every kind.
5. **Working copies.** `pair_working_copy`, `report_working_copy`,
   `list_working_copies`; `oxagen init --pair`, `oxagen status`, `oxagen pull`.
6. **Configuration and drift.** `get_workspace_config`, `list_config_drift`,
   `open_reconcile_pr`, the reconciler job.
7. **Skill and tool pull requests** on the lane phase 1 built (ADR-072).

**Not in scope.** Ontology pull requests (`v2/propose_ontology_version` is an inert
descriptor). The `oxagen config` interview from
`docs/specs/oxagen-workspace-config/design.md` phases 4–6 — that document's `workspace.json`
is the gitignored local file, and §2.1 fixes which is which, but its resolver and interview
agent are their own body of work.

## 6. Open questions

| # | Question | Blocks | Recommendation |
|---|---|---|---|
| Q1 | Does the GitHub App's permission set get widened to Contents/PRs write + Checks write, or does this lane stay on the workspace OAuth token? | 3 | Widen it. `packages/github/src/workspace-token.ts` already mints installation tokens and the steering lane already writes with them; the setup doc is behind the code, and an installation token is the narrower credential. |
| Q2 | One `oxagen_pull_requests` table, or per-kind tables? | 1, 4 | One. The lifecycle is identical for all six kinds and only publication differs; two tables would duplicate the head/base/checks invariants that `context.pr.open.ts` got right once. |
| Q3 | Do the two overlapping record generations (`publish_context_record` / `promote_context_record` vs `merge_context_pr` / `list_records`) get reconciled here? | none | No — name it in the ADR and leave it. It is a real problem and it is not this one. |
| Q4 | Does `set_main_repository` reuse the existing approval machinery or get its own? | 2 | Reuse. `requiresApproval: true` on the contract, as `open_context_pr` and `merge_context_pr` already do. |

## 7. Decisions that need an ADR

- **ADR: `.oxagen/workspace.toml` is committed; `.oxagen/workspace.json` is local.** §2.1.
  Two specs currently imply different things about the same directory, and one of them is
  already written by shipped CLI code.
- **ADR: one pull-request lifecycle for every governed file.** §3, the `merge_oxagen_pr`
  generalisation, and why agent definitions were stranded without it.
