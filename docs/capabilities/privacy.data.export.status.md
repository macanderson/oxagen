# privacy.data.export.status

**Domain:** privacy
**Mode:** sync
**Scope:** the calling user's own export requests
**Surfaces:** api
**Risk level:** low

## Intent

Read where one of the calling person's own data exports has got to, and the
link to the bundle once it is ready.

`export_data` answers the moment it queues, with an id and the status `queued`;
the archive is written later by the Inngest job
(`packages/inngest-functions/src/functions/privacy.export.process.ts`), which
moves the row to `ready` and fills `export_url`. Without this read the id is
all a person ever sees, and the right the export exists to serve is receiving
the data, not starting a job.

## Input

| Field | Type | Notes |
|---|---|---|
| `exportId` | `string (UUID)` | The id `export_data` answered with. |

There is no user-id field, and there will not be one: the handler matches the
row on the authenticated principal, so a person can only ever read their own
bundle. A field here would be a way to enumerate other people's exports.

## Output

| Field | Type | Notes |
|---|---|---|
| `exportId` | `string` | Echoed back. |
| `status` | `"queued" \| "processing" \| "ready" \| "failed"` | The four states `privacy.privacy_export_requests` can hold. |
| `downloadUrl` | `string \| null` | The signed URL, and only while `status` is `ready`. A url left on a row that later failed is not offered. |
| `completedAt` | `string \| null` | ISO 8601, set when the job finished. |

## Refusals

| Code | When |
|---|---|
| `forbidden` / `no_principal` | A machine credential: MCP builds every context with `userId: null`, so this can only refuse there. That is why the capability has no MCP surface. |
| `not_found` / `export_not_found` | No such id, **or** an id belonging to someone else. The two are deliberately the same answer: distinguishing them would tell a caller whether a stranger's export id is real. |

## Surfaces

`GET /v1/privacy/export/:exportId` dispatches this contract. The route used to
query `privacy.privacy_export_requests` directly, outside `invoke()`, so the
read carried no IAM check, no audit row and no parity entry.

In the app it backs the Account dialog's Privacy tab: a queued export is polled
every three seconds until it settles, then the bundle is offered as a download
link (`apps/app/src/features/shell/account-dialog.tsx`). The interval is
cleared when the export settles and when the dialog closes.
