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
| `ready` | `boolean` | Whether the bundle exists and can be fetched. |
| `storageKey` | `string \| null` | The canonical object key, for the serving route to read back; null until the bundle is written. |
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

## Why there is no download URL

The archive is written as a **private** object (`access: "private"`), and
`packages/storage/src/types.ts` is explicit: never render a private object's
`url` in a browser. On Vercel Blob that url needs the store's read-write token;
on the filesystem driver it is the storage key, not a route. So the contract
carries no url at all.

Rows written before that change stored `result.url`, which on Vercel Blob is a
full authenticated URL rather than a key. `storageKey` accepts both: an
absolute URL is reduced to its pathname, which is the key the object was
written under, so an export queued before this shipped still downloads. The
rows are not migrated — a backfill would have to reach every data plane
(ADR-042), and the pathname is recoverable exactly.

Bytes are served by two routes, one per kind of caller, because a storage key
is no use to either on its own:

- `GET /v1/privacy/export/{exportId}/download` for token-authenticated API and
  CLI clients.
- `GET /{org}/account/export/{exportId}` for the cookie-authenticated app.

Both dispatch this capability first and stream `storage().get(storageKey)`
only on a `ready` answer, so authorization is the capability's rather than each
route's, and an export that is not the caller's never reaches storage. Both
answer 409 while the bundle is still being written or after it failed, and both
send `cache-control: private, no-store`.

The app route is described below.

The bytes are served by `GET /{org}/account/export/{exportId}`
(`apps/app/src/features/shell/export-download.ts`), which resolves the viewer,
invokes this capability to confirm the export is theirs and ready, and streams
`storage().get(storageKey)` with `cache-control: private, no-store`. A refusal
from either gate answers before storage is touched, and an export that is not
the caller's answers `not_found` like one that does not exist.
