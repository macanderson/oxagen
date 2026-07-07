# repo.pr.diff

Read the per-file unified-diff patches for a GitHub pull request.

## Mode
**sync**

## Surfaces
- API: `GET /v1/repos/pulls/:number/diff`
- MCP: `repo.pr.diff`
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
| `summary` | string | Human summary, e.g. `"12 files, +340 -58"` |
| `additions` | integer | Total added lines |
| `deletions` | integer | Total deleted lines |
| `changedFiles` | integer | Number of changed files |
| `files` | array | Per-file diff entries (see below) |

### `files[]`
| Field | Type | Description |
|-------|------|-------------|
| `path` | string | Current file path |
| `previousPath` | string \| null | Prior path for renames/copies, else null |
| `status` | `"added" \| "modified" \| "removed" \| "renamed" \| "copied" \| "changed"` | Change status |
| `additions` | integer | Added lines in this file |
| `deletions` | integer | Deleted lines in this file |
| `patch` | string \| null | Unified-diff hunk text; null for binary/too-large |
| `binary` | boolean | Whether the file is binary |

## Example

**Request:**
```http
GET /v1/acme/default/repos/pulls/42/diff?owner=acme&repo=backend-service
```

**Response (200):**
```json
{
  "summary": "2 files, +42 -3",
  "additions": 42,
  "deletions": 3,
  "changedFiles": 2,
  "files": [
    {
      "path": "src/hello.ts",
      "previousPath": null,
      "status": "added",
      "additions": 40,
      "deletions": 0,
      "patch": "@@ -0,0 +1,40 @@\n+export function hello() {}",
      "binary": false
    }
  ]
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Risk level:** low — read-only.
- `binary` is true when GitHub omits `patch` but the file has line changes.
- Fetches up to 100 files (one page of the GitHub files endpoint).

## Related
- `repo.pr.get` — PR summary, stats, comments, and CI
- `repo.ci.status` — generic CI status for a ref
