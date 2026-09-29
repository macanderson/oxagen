# import_workspace_steering

Move the workspace's steering from `.oxagen/` in the repository it binds to a steering repo, and open the steering PRs a person merges (steering spec, Workspace migration; lane S10, #4620; ADR-219).

A workspace owner runs this once for each workspace that still reads `.oxagen/`. The run changes no file on a default branch. Every change is a PR on the host, and a person merges each one.

**Surfaces:** api, mcp

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/steering/repo/import` returns 200
- MCP: `import_workspace_steering`
- Agent: none. The import is a one-time move a person starts, so the contract carries no agent metadata
- CLI: none
- Authentication: org Owner or Admin, or workspace Owner, checked by the handler (INV-29). A call that carries only an API key names no user, so the handler refuses it (`no_principal`) on every surface
- Not billed (`noBillingGate: true`), IAM default-deny, high sensitivity

## Input

| Field | Type | Description |
|---|---|---|
| `ruleKinds` | object, optional | the kind of each v0.1 rule, `business-rule` or `code-rule`, keyed by the old lineage a `needs_choices` answer listed |
| `constraintEffects` | object, optional | the effect of each v0.1 constraint, `require` or `forbid`, keyed by its old lineage |

Send `{}` on the first call. The choices count only until the run changes something. After that, a call runs with the choices it started with.

## Output

| Field | Type | Description |
|---|---|---|
| `outcome` | `imported`, `provisioned`, `nothing_to_import`, or `needs_choices` | how the run ended |
| `steeringRepository` | string or null | `owner/name` of the steering repo |
| `pullRequests` | array of `{ branch, number, url }` | the import steering PRs on the steering repo, in merge order |
| `cleanup` | `{ number, url }` or null | the PR that removes the imported files from the old repository |
| `leftForAPerson` | integer | files, records, and agents the import left for a person, counting each converted file the cleanup PR keeps |
| `rulesNeedingKind` | array of strings | old lineages of the v0.1 rules that need a kind |
| `constraintsNeedingEffect` | array of strings | old lineages of the v0.1 constraints that need an effect |

## Outcomes

| Outcome | When |
|---|---|
| `imported` | the import steering PRs and the cleanup PR are open |
| `provisioned` | the workspace bound no repository, so the run only created the steering repo |
| `nothing_to_import` | the workspace already has a steering repo |
| `needs_choices` | some v0.1 rules need a kind or some constraints need an effect. Nothing changed. Call again with `ruleKinds` and `constraintEffects` |

## What a run does

1. Reads `.oxagen/` at the old repository's production branch and pins that commit. It converts the tree before it changes anything, so a tree the import cannot read changes nothing.
2. Makes the old repository's head linked.
3. Creates and binds the steering repo. When this step fails, the old repository steers the workspace again.
4. Opens the import steering PRs on the steering repo. The records go in batches on `steering/import-oxagen`, `steering/import-oxagen-2`, and so on, each at most 299 files. `workspace.toml` goes on `workspace/import-oxagen`, and each agent goes on its own `agents/<name>` branch.
5. Opens one cleanup PR on the old repository, on `oxagen/import-cleanup`. It removes the files the steering repo now holds. Files the import left for a person stay. A converted file that changed on the old repository after step 1 read it stays too, and the cleanup PR lists it.

Merge the PRs in the order `pullRequests` lists them, then merge the cleanup PR last.

The run records each step in the workspace's `steering_import` setting. A call after a finished run answers what that run did. A call after a stopped run resumes at the step that stopped, and it opens no PR and commits no file twice. The API may time out on a large tree while the run goes on. Call again after 10 minutes to read the answer.

## What the import leaves for a person

- A file under `.oxagen/` that the import does not convert.
- A record with no record id.
- A v0.1 rule with no kind, and a v0.1 constraint with no effect.
- An agent Oxagen holds no operator, runtime, or harness for. The agent registry records no operator yet, so today every agent is left for a person.
- A converted file that changed on the old repository after the import read it. The steering repo holds the version the import read. Move the change with a steering PR, then delete the file.
- A field the steering repo has no place for. The import drops it from the file it converts.

The first import steering PR lists what the import left and each dropped field. The cleanup PR lists the files it keeps and the dropped fields of the files it deletes.

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no signed-in user; not an org Owner or Admin or a workspace Owner |
| `not_found` | `workspace_not_found` | the workspace is gone |
| `conflict` | `steering_import_running` | another run of this workspace saved within the last 10 minutes |
| `conflict` | `steering_import_provider_unsupported` | the workspace binds a repository on a host other than GitHub, such as GitLab |
| `conflict` | `steering_import_source_unreachable` | Oxagen can no longer reach the old repository, or its production branch is gone |
| `conflict` | `steering_import_legacy_connection` | the workspace reads a repository through a sources connection with no binding. Bind the repository with `bind_main_repository`, then run the import |
| `conflict` | `steering_import_source_gone` | the old repository's binding was removed while the run was going. Call again, and the next run reads the workspace afresh |
| `conflict` | `steering_import_branch_taken` | a branch the import writes, such as `oxagen/import-cleanup`, already exists, and Oxagen cannot confirm it holds only this import's commit. A branch that changes 300 or more files always refuses, and the message says so, because the host cannot list that many changes. Delete the branch, then call again |
| `conflict` | `workspace_mismatch`, `governance_unreadable`, `workspace_toml_unreadable`, `too_many_files`, `branch_scope` | the converter cannot read the tree. Nothing changed |
| `conflict` | `steering_repo_provisioning` | another request is creating the steering repo |
| `conflict` | `steering_repo_provision_failed`, `steering_repo_already_bound`, `steering_app_unconfigured`, `repository_name_taken`, `no_connection`, `choose_connection` | the steering repo could not be created. The old repository steers the workspace again |
| `conflict` | `steering_repo_not_ready` | the steering repo has no default branch yet |
| `conflict` | `github_refused` | GitHub refused a branch, commit, or PR. Call again to resume |
