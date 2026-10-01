# get_steering_repo

Read the workspace's steering repo: its provisioning status and step, the repository, the published version, its settings health, and each setting that differs (steering-repo-spec, Provisioning and Settings drift; lane S2, #4560).

The Repositories card, the health banner in the workspace layout, and onboarding read this. The banner renders on every workspace page, so the read answers for every workspace, including one made before provisioning existed.

**Surfaces:** api, mcp, agent

## Mode

**sync**

## Surface

- API: `GET /v1/:org_slug/:workspace_slug/context/steering/repo` returns 200
- MCP: `get_steering_repo`
- CLI: none
- Authentication: every workspace role and the org Owner, Admin, and Compliance roles
- Not billed (`noBillingGate: true`), IAM default-deny, low sensitivity
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).

## Input

None. The org and workspace come from the capability context.

## Output

| Field | Type | Description |
|---|---|---|
| `status` | `not_started`, `provisioning`, `ready`, `failed`, or `blocked` | the provisioning status. `not_started` means the workspace never recorded a setup |
| `step` | step or null | the last provisioning step that finished |
| `failedStep` | step or null | the step that failed or stopped |
| `error` | `{ code, message }` or null | why the step failed or stopped. `steering_reauthorize` asks an organization owner to authorize the Oxagen GitHub App again |
| `provider` | `github`, `gitlab`, or null | the host the repository is on |
| `repository` | `{ fullName, url }` or null | the repository, null until `create_repository` finishes. `url` is `https://github.com/<fullName>` or `https://gitlab.com/<fullName>` |
| `publishedVersion` | positive integer or null | the published steering version |
| `health` | `healthy`, `drifted`, `disconnected`, `diverged`, or null | the settings health from the last health read, null before the first |
| `differences` | array | each prescribed setting that differs: `setting`, `expected`, `actual`, `changedBy`, and `changedAt` |
| `legacySource` | `{ fullName, url, provider }` or null | the code repository that still steers the workspace through its `.oxagen/` tree. [import_workspace_steering](steering_repo.import.md) moves that steering to a steering repo when `provider` is `github`, and refuses a GitLab repository (`steering_import_provider_unsupported`) |
| `connection` | `{ provider, id, name, kind }` or null | where the organization creates its steering repos: the stored GitHub installation or GitLab group. `kind` is `user` for the owner's own personal GitHub account and `organization` otherwise. Null before one is chosen |
| `connectionChoices` | array | the GitHub organizations, personal account, and GitLab groups to choose from when setup stopped with `choose_connection`, each shaped like `connection`. Empty otherwise |

The steps, in the order provisioning runs them, are `pick_connection`, `create_repository`, `add_to_installation`, `write_first_commit`, `apply_settings`, `register_webhook`, `publish_version`, and `bind_repository`.

`expected` and `actual` are rendered as text: `unset` for a missing value, otherwise JSON cut at 120 characters.

## Sources

- **Provisioning** comes from the `steering_repo` key of the workspace's settings, which the provisioning job writes.
- **The published version** comes from the steering publication of the repository. Provisioning records version 1 as a host deployment in `publish_version`. In a workspace, `bind_repository` then publishes the first commit through the version store as version 1, so the first merged steering PR publishes version 2 (#4732). An organization's repository has no bind step, so its version store holds nothing until the first publish. Until a publication exists, the read answers 1 once `publish_version` has finished.
- **Health and differences** come from the last health read. With no read yet, `health` is null and `differences` is empty.

## No provisioning state

A workspace with no `steering_repo` state answers `status: "not_started"` with every other provisioning field null and no differences (#4875). Before #4875 it answered `provisioning`, which read the same as a setup whose job was queued. The read does not fail, because the banner that calls it sits on every page of the workspace.

A workspace made before steering repos existed has no state, and its old main repository still steers it. `legacySource` names that repository. Setup for such a workspace runs through [import_workspace_steering](steering_repo.import.md), because provisioning stops with `steering_import_required` while a code repository holds the workspace's steering head.

## Changing the connection

Mac decided on 2026-10-01 that an owner may change the stored connection until Oxagen has created a steering repo in it (#4899). Send `resetConnection: true` to [retry_steering_repo_provision](steering_repo.provision.retry.md), or to `import_workspace_steering` for a workspace with a `legacySource`. The run lists the candidates again. The reset is refused (`connection_in_use`) once any setup of the organization recorded a repository in the stored account.

## Choosing a connection

When the owner's tokens reach more than one GitHub organization or GitLab group, setup stops at `pick_connection` with `choose_connection` and lists them in `connectionChoices`. Pass one as `connection` to [retry_steering_repo_provision](steering_repo.provision.retry.md), or to `import_workspace_steering` for a workspace with a `legacySource`.

## Retry

While `status` reads `failed` or `blocked`, [retry_steering_repo_provision](steering_repo.provision.retry.md) resumes the same setup from the step that stopped it, instead of starting over (#4750).

## Refusals

The handler refuses no input. The kernel's IAM check refuses a caller without one of the roles above.
