# image.analyze

**Domain:** image
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Analyze an image by ID — returns description, tags, and analysis.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| image_id | string | Image ID to analyze |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| analysis | string | Text analysis of the image |
| tags | array of strings | Inferred tags or labels |
| description | string | Human-readable description |

## Side effects

LLM call for image analysis (ClickHouse telemetry). Reads image from blob
storage.

## Errors

None explicitly defined in the contract.
