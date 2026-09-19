# get_record

**Name:** `get_record`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Billing:** `noBillingGate: true`
**Mutates:** no

## Intent

One record by id ([ADR-061](../adr/ADR-061-steering-governance-mode-thresholds-and-the-reflector.md); MC spec §9, App. E): a published record by its `ctr_` public id or its lineage id, with its versions and the Context PR that published it; or a record an agent appended, by its `cta_` public id, with its provenance.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `recordId` | `string` | A `ctr_` public id, a lineage id, or a `cta_` public id |

## Output

A discriminated union on `source`.

`source: "published"`:

| Field | Type | Source |
| --- | --- | --- |
| `record` | the `list_records` row | `agent.context_records` joined to its active version |
| `versions[]` | `{ id (crv_…), version, checksum, isLatest, publishedAt }` | `agent.context_record_versions`, newest first |
| `proposalId` | `string \| null` | The merged `agent.context_proposals` row that published the active version |
| `prUrl` | `string \| null` | That proposal's pull request |

`source: "appended"`:

| Field | Type | Source |
| --- | --- | --- |
| `record.id` | `string` | `agent.context_appends.public_id` (`cta_…`) |
| `record.kind` | the seven §9 kinds | `context_appends.kind` |
| `record.lineageId` / `.statement` / `.sharingScope` | | as appended |
| `record.recordHash` | `sha256:…` | The canonical hash (packages/run-evidence `recordHash`) |
| `record.sourceRefs[]` / `.evidenceLinks[]` | `string[]` | Frames and records it derives from; what proves it |
| `record.proposalId` | `string \| null` | The proposal a `record_proposal` append opened |
| `record.createdAt` | RFC 3339 | |

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `not_found` | `record_not_found` | No record with that id in this workspace (404). |
