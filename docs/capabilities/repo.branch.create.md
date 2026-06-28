# repo.branch.create

Create a new branch in a GitHub repository, optionally from another branch.

## Mode
**sync**

## Surfaces
- API: `POST /v1/repos/branch`
- Agent: callable (no approval required, risk: high)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `owner` | string | yes | Repository owner (user or organisation) |
| `repo` | string | yes | Repository name |
| `branch` | string | yes | Name of the new branch to create |
| `fromBranch` | string | no | Branch to base the new branch on (defaults to the repository default branch) |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `ref` | string | Full Git ref of the newly created branch (e.g. `refs/heads/my-feature`) |
| `sha` | string | SHA that the new branch points to |

## Example

**Request:**
```http
POST /v1/acme/default/repos/branch
Content-Type: application/json

{
  "owner": "acme",
  "repo": "backend-service",
  "branch": "feature/add-hello",
  "fromBranch": "main"
}
```

**Response (201):**
```json
{
  "ref": "refs/heads/feature/add-hello",
  "sha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Risk level:** high — creates a persistent git ref in a third-party system.
- The caller must have a valid GitHub credential stored via `plugin.credential.set_secret` for the GitHub integration.
- Branch names follow standard Git ref conventions; slashes are allowed (e.g. `feature/my-feature`).
- If `fromBranch` is omitted, the new branch is created from the repository's default branch (e.g. `main`).

## Related
- `repo.file.put` — commit a file to the new branch
- `repo.pr.open` — open a pull request after committing to the branch
- `repo.create` — create a repository before branching
- `repo.fork` — fork a repository before branching
