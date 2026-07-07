# repo.pr.get

Read a GitHub pull request's summary, diff stats, comments, and CI status.

## Mode
**sync**

## Surfaces
- API: `GET /v1/repos/pulls/:number`
- MCP: `repo.pr.get`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `owner` | string | yes | Repository owner (user or organisation) |
| `repo` | string | yes | Repository name |
| `number` | integer | yes | Pull request number |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `number` | integer | Pull request number |
| `title` | string | Pull request title |
| `url` | string | HTML URL of the pull request |
| `state` | `"open" \| "closed" \| "merged"` | Effective state (merged distinguished from closed) |
| `draft` | boolean | Whether the PR is a draft |
| `author` | string \| null | PR author login |
| `authorAvatarUrl` | string \| null | PR author avatar URL |
| `createdAt` | string | ISO 8601 creation timestamp |
| `updatedAt` | string | ISO 8601 last-updated timestamp |
| `body` | string \| null | PR description body (Markdown) |
| `baseRef` | string | Base branch the PR targets |
| `headRef` | string | Head branch containing the changes |
| `headSha` | string \| null | Head commit SHA |
| `additions` | integer | Total added lines |
| `deletions` | integer | Total deleted lines |
| `changedFiles` | integer | Number of changed files |
| `commits` | integer | Number of commits |
| `commentCount` | integer | Total issue comments (true count) |
| `reviewCommentCount` | integer | Total inline review comments (true count) |
| `comments` | array | Capped list actually fetched (≤ 50), newest first |
| `ci` | object | CI status for the PR head (`overall`, `counts`, `runs`) |

### `comments[]`
| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Comment id |
| `author` | string \| null | Comment author login |
| `authorAvatarUrl` | string \| null | Author avatar URL |
| `body` | string | Comment body (Markdown) |
| `createdAt` | string | ISO 8601 creation timestamp |
| `url` | string \| null | HTML URL of the comment |
| `kind` | `"issue" \| "review"` | Conversation vs inline code comment |
| `path` | string \| null | File path for review comments, else null |

## Example

**Request:**
```http
GET /v1/acme/default/repos/pulls/42?owner=acme&repo=backend-service
```

**Response (200):**
```json
{
  "number": 42,
  "title": "feat: add hello utility",
  "url": "https://github.com/acme/backend-service/pull/42",
  "state": "open",
  "draft": false,
  "author": "octocat",
  "authorAvatarUrl": "https://avatars.githubusercontent.com/u/1?v=4",
  "createdAt": "2026-07-06T10:00:00Z",
  "updatedAt": "2026-07-06T10:30:00Z",
  "body": "Adds a hello() utility.",
  "baseRef": "main",
  "headRef": "feature/add-hello",
  "headSha": "a1b2c3d4",
  "additions": 42,
  "deletions": 3,
  "changedFiles": 2,
  "commits": 1,
  "commentCount": 2,
  "reviewCommentCount": 1,
  "comments": [],
  "ci": { "overall": "passing", "counts": { "total": 1, "passed": 1, "failed": 0, "pending": 0, "skipped": 0, "neutral": 0 }, "runs": [] }
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Risk level:** low — read-only.
- `commentCount` / `reviewCommentCount` are GitHub's true totals; `comments` is a capped (≤ 50), newest-first sample of issue + review comments.
- `ci` mirrors `repo.ci.status` minus `ref`/`sha`, computed against the PR head SHA.

## Related
- `repo.pr.diff` — real unified-diff patches for the same PR
- `repo.ci.status` — generic CI status for any ref
- `repo.pr.open` — open a pull request
