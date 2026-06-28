# repo.pr.open

Open a pull request in a GitHub repository.

## Mode
**sync**

## Surfaces
- API: `POST /v1/repos/pulls`
- Agent: callable (no approval required, risk: high)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `owner` | string | yes | Repository owner (user or organisation) |
| `repo` | string | yes | Repository name |
| `title` | string | yes | Pull request title |
| `head` | string | yes | Branch containing the changes (e.g. `feature/my-branch`) |
| `base` | string | yes | Branch the PR is targeting (e.g. `main`) |
| `body` | string | no | Pull request description body (Markdown) |
| `draft` | boolean | no | Open as a draft pull request |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `number` | integer | Pull request number |
| `htmlUrl` | string | HTML URL of the pull request |

## Example

**Request:**
```http
POST /v1/acme/default/repos/pulls
Content-Type: application/json

{
  "owner": "acme",
  "repo": "backend-service",
  "title": "feat: add hello utility",
  "head": "feature/add-hello",
  "base": "main",
  "body": "Adds a `hello()` utility function.\n\n## Changes\n- `src/hello.ts`",
  "draft": false
}
```

**Response (201):**
```json
{
  "number": 42,
  "htmlUrl": "https://github.com/acme/backend-service/pull/42"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Risk level:** high — creates a pull request visible to all repository collaborators.
- The caller must have a valid GitHub credential stored via `plugin.credential.set_secret` for the GitHub integration.
- The `head` branch must already exist and have at least one commit ahead of `base`.
- Draft PRs can be marked ready for review on GitHub directly; the platform does not expose a separate `repo.pr.ready` capability.

## Related
- `repo.branch.create` — create the `head` branch before opening the PR
- `repo.file.put` — commit changes to the `head` branch
- `repo.fork` — open a cross-fork PR by specifying `head` as `fork-owner:branch`
- `repo.create` — create the repository the PR targets
