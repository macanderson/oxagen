# repo.file.put

Commit a file (create or update) to a GitHub repository. Content is provided as raw UTF-8 text; base64 encoding for the GitHub API is handled internally.

## Mode
**sync**

## Surfaces
- API: `PUT /v1/repos/file`
- Agent: callable (no approval required, risk: high)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `owner` | string | yes | Repository owner (user or organisation) |
| `repo` | string | yes | Repository name |
| `path` | string | yes | File path within the repository (e.g. `src/index.ts`) |
| `content` | string | yes | Raw UTF-8 file content |
| `message` | string | yes | Commit message |
| `branch` | string | no | Branch to commit to (defaults to the repository default branch) |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `commitSha` | string | SHA of the commit that created or updated the file |
| `htmlUrl` | string | HTML URL of the committed file |
| `diffs?` | `{ path, patch, additions, deletions }[]` | Single-element array with the committed file's unified diff (before content on the target branch, or `""` for a new file, vs. the newly committed `content`). Powers the chat `code-diff` card's full hunk view. |

## Example

**Request:**
```http
PUT /v1/acme/default/repos/file
Content-Type: application/json

{
  "owner": "acme",
  "repo": "backend-service",
  "path": "src/hello.ts",
  "content": "export const hello = () => 'Hello, world!';",
  "message": "feat: add hello utility",
  "branch": "feature/hello"
}
```

**Response:**
```json
{
  "commitSha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "htmlUrl": "https://github.com/acme/backend-service/blob/feature/hello/src/hello.ts"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Risk level:** high — permanently commits code to a branch in a third-party system.
- The caller must have a valid GitHub credential stored via `plugin.credential.set_secret` for the GitHub integration.
- If the file already exists, this performs an update commit. If it does not exist, it creates the file.
- The `branch` must already exist; use `repo.branch.create` first if needed.

## Related
- `repo.branch.create` — create a branch before committing
- `repo.pr.open` — open a pull request after committing
- `repo.create` — create a new repository
- `repo.fork` — fork an existing repository
