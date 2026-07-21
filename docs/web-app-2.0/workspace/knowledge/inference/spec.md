---
# Inference (retired for launch)

- **Route:** `/{orgSlug}/{workspaceSlug}/knowledge/inference`
- **Nav location:** removed from workspace navigation
- **Priority:** Post-launch redesign
- **Disposition vs today:** Delete / hide

## Purpose
This page and its legacy semantic-edge capability family are retired for launch. Oxagen does not currently expose a relationship infer/list/suggest/approve workflow, and no model-generated relationship may be materialized through confidence alone.

## Primary user & jobs-to-be-done
- **Primary user:** a data owner or admin curating graph quality
- **JTBD:**
  - No launch jobs are served by this route; graph health remains on the graph surface.
  - A future candidate-review experience must start from a replacement governed spec.

## Functionality
- Route and navigation entry are absent at launch.
- No pending queue, approved-edge browser, bulk review action, or inference trigger is exposed.
- Future relationship candidates must preserve producer provenance, require explicit authorized approval, emit durable audit events, and support invalidation/revocation.

## Capabilities invoked
None.

## Data sources
None at launch.

## States
- The route is not registered, so it has no launch loading, empty, or error states.

## Existing implementation
- The former page, sections, navigation entry, and semantic-edge capability family are deleted. Do not restore them without an approved replacement specification.

## Vision alignment
Deferring this surface prevents an incomplete candidate model from becoming an ungoverned shared-context write path. The future value remains human-approved, attributable, time-aware relationships with explicit revocation.
