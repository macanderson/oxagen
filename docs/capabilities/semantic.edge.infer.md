# semantic.edge.infer

Run LLM inference to discover and link nodes across sources with confidence scores. Triggers an async job; edges at or above the `confidenceThreshold` are auto-accepted, edges below it are staged for human review via `semantic.edge.suggest`.

## Mode
**async**

## Surfaces
- API: `POST /v1/semantic-edges/infer`
- MCP: `semantic.edge.infer`
- Agent: callable (requires approval, risk: high)
- CLI: not available

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `semanticEdgePrompt` | string (1–4000 chars) | yes | Custom prompt instructing the LLM on how to identify and type relationships between nodes |
| `sourceIds` | string[] | no | Restrict inference to nodes from these connector source IDs; omit to consider all sources |
| `maxEdgesPerNode` | integer (1–50) | no | Maximum inferred edges per node; default 10 |
| `dryRun` | boolean | no | Preview inferred edges without persisting them; default `false` |
| `confidenceThreshold` | number (0.0–1.0) | no | Edges at or above this score are auto-accepted; edges below are staged for review; default 0.8 |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `jobId` | string | Background job ID — poll via job status or listen for webhook completion |
| `status` | `"queued"` | Always `queued` on initial dispatch |
| `estimatedNodes` | number | Approximate number of nodes that will be evaluated |
| `dryRun` | boolean | Mirrors the `dryRun` input flag |

## Example

**Request:**
```http
POST /v1/semantic-edges/infer
Content-Type: application/json

{
  "semanticEdgePrompt": "Identify relationships between Jira issues and GitHub pull requests. Use relation type IMPLEMENTS when a PR closes or references a Jira ticket.",
  "sourceIds": ["intg_jira_abc", "repo_github_xyz"],
  "confidenceThreshold": 0.85,
  "maxEdgesPerNode": 5
}
```

**Response (202):**
```json
{
  "jobId": "job_infer_789",
  "status": "queued",
  "estimatedNodes": 2150,
  "dryRun": false
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Agent requires approval** before executing this action.
- **Async:** Returns `202 Accepted`. The job runs inference over all (or filtered) nodes and writes edges to Neo4j.
- Edges below `confidenceThreshold` are persisted but marked as `approved: false`. They appear in `semantic.edge.suggest` for human review.
- `dryRun: true` returns edges via the job result payload without writing to Neo4j. Useful for tuning the prompt.
- High `maxEdgesPerNode` values on large graphs can result in very long-running jobs.

## Related
- `semantic.edge.list` — browse all inferred edges
- `semantic.edge.suggest` — review unapproved edge candidates
- `integration.configure` — set `semanticEdgePrompt` per integration source
