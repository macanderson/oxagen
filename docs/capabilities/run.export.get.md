# get_run_export

Read one run export back: where the job stands, the bundle's digest and size once it is built, the job's error if it failed, and a download URL that expires (Mission Control spec §13.4, App. E; ADR-058). `export_run` queues the bundle and answers an export id. This capability is how every surface turns that id into a file.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/export-status`
- MCP: `get_run_export`
- CLI: `oxagen run export-status <export-id> [--json]`, and `oxagen run download <export-id> [--out <file>]`, which reads this capability and fetches the URL
- App: the Run page polls it after **Export** and shows the download link when the bundle is ready
- Authentication: session or API key; org Owner or Admin, checked in the handler (`assertOrgRole`), the same gate as `export_run`
- Capability name: `get_run_export`
- `mutates: false`; not billed (`noBillingGate: true`). IAM default-deny; high sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `exportId` | string | yes | `rexp_…`, from `export_run` |

## Output

| Field | Type | Description |
|---|---|---|
| `exportId` | string | the export's public id |
| `runId` | string | the run it exports (`arun_…` or `tse_…`) |
| `status` | `queued`, `building`, `ready`, or `failed` | where the job stands |
| `createdAt` | ISO 8601 | when `export_run` queued it |
| `completedAt` | ISO 8601 or null | when the bundle was written |
| `bundleDigest` | `sha256:…` or null | digest of the zip as stored |
| `bundleBytes` | integer or null | size of the zip; null for a bundle built before the size was recorded |
| `merkleRoot` | `sha256:…` or null | the root the attestation signs |
| `frameCount` | integer or null | frames in the bundle |
| `error` | string or null | why the job failed |
| `download` | `{ url, expiresAt }` or null | set only when `status` is `ready` |

## The download URL

The URL points at `GET /v1/run-exports/download?token=…` on the API. It needs no session, so the person who verifies the bundle can fetch it with the link alone. The token names the export, its organisation and workspace, and the bundle digest, and it is signed with HMAC-SHA256 under the deployment's export signing secret (`AUDIT_EXPORT_SIGNING_SECRET`, or `BETTER_AUTH_SECRET` when that is unset) with its own domain prefix. It expires 15 minutes after the read that minted it. Reading `get_run_export` again mints a new one.

The route answers `404` for a missing, forged, or expired token, for an export that is not ready, and for one whose stored digest no longer matches the token. A good token streams `application/zip` with `X-Bundle-Digest` set to the bundle digest.

## Errors

- `forbidden` (403): the actor is not an org Owner or Admin.
- `not_found` (404) `run_export_not_found`: no export with that id in the caller's workspace.

## Verifying the bundle

`oxagen verify <bundle.zip>` checks the bundle offline. See [Export and verify a run](../guides/export-and-verify.md).
