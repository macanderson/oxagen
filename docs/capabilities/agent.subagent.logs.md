# agent.subagent.logs

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Generate a **downloadable markdown logfile** for a fan-out (a research swarm or
any `agent.subagent.dispatch`). It reads every child run's full input + output
via `agent.subagent.aggregate` (`children`) and writes a markdown log — traceable
down to each subagent's query and its individual results — to an
access-controlled, downloadable document asset.

This is the "download individual swarm subagent logfiles to see the activities
fully traceable down to individual queries and results" capability. The output
is a real document (`text/markdown`), served through
`/api/v1/assets/<publicId>`, rendered as a `file-attachment` card — **not** a zip.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| fanoutId | string | The fan-out / dispatch id (the `dispatchId` from `research.swarm.start` or `agent.subagent.dispatch`) |
| title | string? | Optional title for the log document |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| assetId | string | Internal asset id |
| publicId | string | `gen_…` public id used in the serving URL |
| childCount | number | Number of subagent runs included |
| mimeType | string | `text/markdown` |
| sizeBytes | number | Document size |
| url / serveUrl | string | Blob URL / access-controlled serving path |
| render | object | `file-attachment` directive (kind `document`) |

## Side effects

- One `agent.subagent.aggregate` read of the fan-out's children.
- Writes one `text/markdown` document to blob storage (`accessPolicy: org`) and a
  `generated_assets` row. Downloadable through the access-controlled asset route.

## Chaining

Consumes `swarm.id`; produces `asset.id` / `document.text`. Typical use:
`research.swarm.start → research.swarm.status → agent.subagent.logs` to hand the
user a complete, traceable record of every query and result the swarm ran.
