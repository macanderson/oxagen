# repo.fork

Fork a GitHub repository into the authenticated user's account or a specified organization.

## Mode
**sync**

## Surfaces
- API: `POST /v1/repos/fork`
- Agent: callable (no approval required, risk: high)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `owner` | string | yes | Repository owner (user or organisation) |
| `repo` | string | yes | Repository name |
| `intoOrg` | string | no | Fork into this organisation instead of the authenticated user's personal account |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `fullName` | string | Owner/repo full name of the fork (e.g. `myorg/myrepo`) |
| `htmlUrl` | string | HTML URL of the fork |
| `defaultBranch` | string | Default branch name of the fork |

## Example

**Request:**
```http
POST /v1/acme/default/repos/fork
Content-Type: application/json

{
  "owner": "openai",
  "repo": "openai-node",
  "intoOrg": "acme"
}
```

**Response (201):**
```json
{
  "fullName": "acme/openai-node",
  "htmlUrl": "https://github.com/acme/openai-node",
  "defaultBranch": "main"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Risk level:** high — creates a persistent resource in a third-party system.
- The caller must have a valid GitHub credential stored via `plugin.credential.set_secret` for the GitHub integration.
- GitHub may queue the fork asynchronously for large repositories; the returned `htmlUrl` is available immediately but the fork content may take a few seconds to populate.
- If `intoOrg` is omitted, the fork is created in the authenticated user's personal account.

## Related
- `repo.create` — create a brand-new repository instead of forking
- `repo.branch.create` — create a branch inside the forked repository
- `repo.file.put` — commit files to the forked repository
- `repo.pr.open` — open a pull request from the fork back to the source
