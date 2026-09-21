# get_export_status

**Domain:** privacy
**Mode:** sync
**Scope:** the calling user's own export requests
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Read where one of the calling person's own data exports has got to.

It answers a status and, once the bundle exists, the storage key that names it.
It does not answer a link, and no field in its output ever will: the archive is
a private object, so it is fetched from the separate authenticated route
`GET /v1/{org}/{workspace}/privacy/export/{exportId}/download`, which reads the
key back and streams the bytes. A client polls this capability until `ready` is
true, then calls that route. Waiting for a URL to appear here is waiting for
something that never arrives. The reasoning is under "Why there is no download
URL" below.

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
| `forbidden` / `no_principal` | A machine credential with no authenticated user. CLI-session MCP credentials retain their approving user and may read that person's exports. |
| `not_found` / `export_not_found` | No such id, **or** an id belonging to someone else. The two are deliberately the same answer: distinguishing them would tell a caller whether a stranger's export id is real. |
| `forbidden` / `org_export_requires_admin` | The export's scope is `org` and the caller is no longer an Owner or Admin of the organization that governed it. See below. |
| `forbidden` / `org_export_not_permitted` | The export's scope is `org` and an explicit rule now denies `export_data`, either in the workspace that queued the export or in the one the read comes through. See below. |
| `forbidden` / `org_export_scope_unknown` | The export's scope is `org` and the row was written before the queuing workspace was recorded, so a deny there cannot be checked. Request a new export. |

## Organization exports are re-authorized at read time

`export_data` takes a `scope` of `user` or `org`, and refuses an `org` request
from anyone below Owner or Admin. That check is in its handler rather than in
`defaultRoles`, because the rule turns on an input field and a role map cannot
read one.

A queue is not a download. The archive is assembled by an Inngest job minutes
later, and in that window an Owner can be demoted or removed from the
organization. Matching the row on the id, the person and the organization alone
would then still answer: an ordinary member would hold the key to the full
organization archive, everyone's data, on authority they no longer have. With
`defaultEffect: "allow"` the kernel does not catch it either, and both download
routes trust this answer.

So the handler re-reads the membership role for a row whose scope is `org`, and
refuses when it is no longer Owner or Admin. The role is read through
`packages/handlers/src/_org_membership.ts`, the one place that knows
`org_users.role` is written in both casings. A personal export takes no second
read: it is the caller's own data and no role ever gated it.

The role is one of two ways the mandate is taken back. The other is an
explicit `deny` on `export_data` itself, which the role cannot see, so the
handler asks `export_data`'s policy too. It asks in the workspace that queued
the export and again in the one the read comes through, and either refusal
refuses the read. The download route is mounted under any workspace slug, so
asking only in the calling workspace would let a deny in the queuing workspace
be stepped around. `export_data` records the queuing workspace on the row, or
the org-only sentinel for a queue made in no workspace. A row written before
that column existed has no recorded scope, and its organization archive is
refused rather than released on a check that may be asking the wrong
workspace.

## Surfaces

The MCP `get_export_status` tool completes the polling path for `export_data`.
It uses the same handler and user and organization authorization as the API.

`GET /v1/{org}/{workspace}/privacy/export/{exportId}` dispatches this
contract. The route file spells its paths relative to the mount; `apps/api`
mounts the whole family under `/v1/:org_slug/:workspace_slug`, so both segments
are part of every URL a client calls. The route used to
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
rows are not migrated. A backfill would have to reach every data plane
(ADR-042), and the pathname is recoverable exactly.

Bytes are served by two routes, one per kind of caller, because a storage key
is no use to either on its own:

- `GET /v1/{org}/{workspace}/privacy/export/{exportId}/download` for
  token-authenticated API and CLI clients.
- `GET /{org}/account/export/{exportId}` for the cookie-authenticated app.

Both dispatch this capability first and stream `storage().get(storageKey)`
only on a `ready` answer, so authorization is the capability's rather than each
route's, and an export that is not the caller's never reaches storage. Both
answer 409 while the bundle is still being written or after it failed, and both
send `cache-control: private, no-store`. The app route
(`apps/app/src/features/shell/export-download.ts`) resolves the viewer first,
so a signed-out visitor is refused before the capability is dispatched.

A refusal answers before storage is touched. An export that is not the
caller's answers 404, like one that does not exist; an organization export the
caller may no longer read answers 403; a read that failed because Postgres or
the kernel is down answers 503, never 404, because the archive is still there
and the caller should come back.
