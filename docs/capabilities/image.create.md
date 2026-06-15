# image.create

**Domain:** image
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Generate an image from a prompt and persist it as a workspace asset.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| prompt | string | Image generation prompt (required, non-empty) |
| model | enum | Model to use: "gpt-image-1" or "flux-2-max" (default: "gpt-image-1") |
| size | string? | Image size specification (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| image_id | string | Unique image identifier |
| url | string | Image URL (served from Vercel Blob) |
| created_at | string | ISO 8601 creation timestamp |

## Side effects

LLM image generation API call (ClickHouse telemetry). Image persisted to
Vercel Blob. Metadata row in Postgres content.generated_assets.

## Errors

None explicitly defined in the contract.
