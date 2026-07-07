# repo.ci.status

Read CI check-run and commit-status results for a ref in a GitHub repository.

## Mode
**sync**

## Surfaces
- API: `GET /v1/repos/ci/status`
- MCP: `repo.ci.status`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `owner` | string | yes | Repository owner (user or organisation) |
| `repo` | string | yes | Repository name |
| `ref` | string | yes | Branch name, commit SHA, or PR head ref to read CI for |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `ref` | string | The ref that was queried |
| `sha` | string \| null | Resolved commit SHA for the ref |
| `overall` | `"passing" \| "failing" \| "pending" \| "neutral" \| "unknown"` | Aggregated CI verdict |
| `counts` | object | `{ total, passed, failed, pending, skipped, neutral }` |
| `runs` | array | Every check run and legacy status (see below) |

### `runs[]`
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Check run or status context name |
| `status` | `"queued" \| "in_progress" \| "completed"` | Lifecycle status |
| `conclusion` | `"success" \| "failure" \| "neutral" \| "cancelled" \| "timed_out" \| "action_required" \| "skipped" \| "stale" \| null` | Terminal conclusion, null while running |
| `url` | string \| null | Details URL, if any |
| `startedAt` | string \| null | ISO 8601 start timestamp |
| `completedAt` | string \| null | ISO 8601 completion timestamp |
| `durationMs` | number \| null | Elapsed run time in milliseconds |
| `app` | string \| null | Owning app, e.g. `"GitHub Actions"` |

## Example

**Request:**
```http
GET /v1/acme/default/repos/ci/status?owner=acme&repo=backend-service&ref=feature/add-hello
```

**Response (200):**
```json
{
  "ref": "feature/add-hello",
  "sha": "a1b2c3d4",
  "overall": "passing",
  "counts": { "total": 3, "passed": 3, "failed": 0, "pending": 0, "skipped": 0, "neutral": 0 },
  "runs": [
    {
      "name": "build",
      "status": "completed",
      "conclusion": "success",
      "url": "https://github.com/acme/backend-service/runs/1",
      "startedAt": "2026-07-06T10:00:00Z",
      "completedAt": "2026-07-06T10:02:00Z",
      "durationMs": 120000,
      "app": "GitHub Actions"
    }
  ]
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Risk level:** low — read-only.
- Merges the Checks API (`check-runs`) with legacy combined statuses (`status`) into one `runs` array.
- `overall`: any failure/timed_out/cancelled/action_required → `failing`; else any queued/in_progress → `pending`; else all success → `passing`; else `neutral`; empty → `unknown`.

## Related
- `repo.pr.get` — embeds this CI summary for a PR head
- `repo.pr.diff` — real unified-diff patches for a PR
