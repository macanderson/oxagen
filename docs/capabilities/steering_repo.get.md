# get_steering_repo

Read the workspace's steering repo: its provisioning status and step, the repository, the published version, its settings health, and each setting that differs (steering-repo-spec, Provisioning and Settings drift; lane S2, #4560).

The Repositories card, the health banner in the workspace layout, and onboarding read this. The banner renders on every workspace page, so the read answers for every workspace, including one made before provisioning existed.

**Surfaces:** api, mcp

## Mode

**sync**

## Surface

- API: `GET /v1/:org_slug/:workspace_slug/context/steering/repo` returns 200
- MCP: `get_steering_repo`
- CLI: none
- Authentication: every workspace role and the org Owner, Admin, and Compliance roles
- Not billed (`noBillingGate: true`), IAM default-deny, low sensitivity

## Input

None. The org and workspace come from the capability context.

## Output

| Field | Type | Description |
|---|---|---|
| `status` | `provisioning`, `ready`, `failed`, or `blocked` | the provisioning status |
| `step` | step or null | the last provisioning step that finished |
| `failedStep` | step or null | the step that failed or stopped |
| `error` | `{ code, message }` or null | why the step failed or stopped. `steering_reauthorize` asks an organization owner to authorize Oxagen Steering again |
| `provider` | `github`, `gitlab`, or null | the host the repository is on |
| `repository` | `{ fullName, url }` or null | the repository, null until `create_repository` finishes. `url` is `https://github.com/<fullName>` or `https://gitlab.com/<fullName>` |
| `publishedVersion` | positive integer or null | the published steering version |
| `health` | `healthy`, `drifted`, `disconnected`, `diverged`, or null | the settings health from the last health read, null before the first |
| `differences` | array | each prescribed setting that differs: `setting`, `expected`, `actual`, `changedBy`, and `changedAt` |

The steps, in the order provisioning runs them, are `pick_connection`, `create_repository`, `add_to_installation`, `write_first_commit`, `apply_settings`, `publish_version`, and `bind_repository`.

`expected` and `actual` are rendered as text: `unset` for a missing value, otherwise JSON cut at 120 characters.

## Sources

- **Provisioning** comes from the `steering_repo` key of the workspace's settings, which the provisioning job writes.
- **The published version** comes from the steering publication of the repository. Provisioning records version 1 as a host deployment and writes no publication, so the read answers 1 once `publish_version` has finished and before the first publish writes one.
- **Health and differences** come from the last health read. With no read yet, `health` is null and `differences` is empty.

## No provisioning state

A workspace with no `steering_repo` state answers `status: "provisioning"` with every other field null and no differences. The read does not fail, because the banner that calls it sits on every page of the workspace.

## Refusals

The handler refuses no input. The kernel's IAM check refuses a caller without one of the roles above.
