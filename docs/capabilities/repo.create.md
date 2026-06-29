# repo.create

Create a new GitHub repository. Omit `org` to create it in the connected user's
personal account; pass `org` only to create it inside a GitHub organisation the
user belongs to.

## Mode
**sync**

## Surfaces
- API: `POST /v1/repos`
- Agent: callable (no approval required, risk: high)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `org` | string | no | GitHub organisation slug to create the repository in. Omit to create the repository in the connected user's personal account. |
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

**Personal-account request (omit `org`):**
```http
POST /v1/acme/default/repos
Content-Type: application/json

{
  "name": "hello-world",
  "autoInit": true
}
```

Creates `hello-world` in the connected user's personal account
(`POST /user/repos`), e.g. `macanderson/hello-world`.

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Risk level:** high — creates a persistent resource in a third-party system.
- The caller must have a valid GitHub credential stored via `plugin.credential.set_secret` for the GitHub integration.
- **`org` is optional.** With `org`, the repo is created in that organisation (`POST /orgs/{org}/repos`); without it, in the connected user's personal account (`POST /user/repos`). Passing a personal username as `org` 404s — a user is not an organisation — so leave `org` empty for personal repos.
- Repository names must be unique within the target account (org or personal).

## Related
- `repo.fork` — fork an existing repository instead of creating a fresh one
- `repo.branch.create` — create a branch inside a repository
- `repo.file.put` — commit a file to a repository
- `repo.pr.open` — open a pull request
