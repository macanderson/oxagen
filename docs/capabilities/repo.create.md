# repo.create

Create a new GitHub repository in an organization the user owns.

## Mode
**sync**

## Surfaces
- API: `POST /v1/repos`
- Agent: callable (no approval required, risk: high)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `org` | string | yes | GitHub organisation slug to create the repository in |
| `name` | string | yes | Repository name |
| `description` | string | no | Short repository description |
| `private` | boolean | no | Whether the repository is private (default: `false`) |
| `autoInit` | boolean | no | Initialise the repository with a README (default: `false`) |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `fullName` | string | Owner/repo full name (e.g. `myorg/myrepo`) |
| `htmlUrl` | string | HTML URL of the new repository |
| `defaultBranch` | string | Default branch name |

## Example

**Request:**
```http
POST /v1/acme/default/repos
Content-Type: application/json

{
  "org": "acme",
  "name": "backend-service",
  "description": "Core backend API",
  "private": true,
  "autoInit": true
}
```

**Response (201):**
```json
{
  "fullName": "acme/backend-service",
  "htmlUrl": "https://github.com/acme/backend-service",
  "defaultBranch": "main"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Risk level:** high — creates a persistent resource in a third-party system.
- The caller must have a valid GitHub credential stored via `plugin.credential.set_secret` for the GitHub integration.
- Repository names must be unique within the organisation.

## Related
- `repo.fork` — fork an existing repository instead of creating a fresh one
- `repo.branch.create` — create a branch inside a repository
- `repo.file.put` — commit a file to a repository
- `repo.pr.open` — open a pull request
