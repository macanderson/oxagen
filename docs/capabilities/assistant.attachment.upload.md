# upload_assistant_attachment

**Domain:** assistant
**Mode:** sync
**Scope:** workspace (`scoped: true`)
**Surfaces:** api, mcp
**Sensitivity:** medium
**Default effect:** deny
**Roles:** org Owner, Admin; workspace Owner, Member
**Billing gate:** none
**Agent tool:** no

Contract: `packages/oxagen/src/contracts/assistant.attachment.upload.ts`
Handler: `packages/handlers/src/assistant.attachment.upload.ts`
API: `POST /v1/:org_slug/:workspace_slug/assistant/attachments/upload`
Read back: `GET /v1/:org_slug/:workspace_slug/assistant/attachments/:publicId`
MCP: `upload_assistant_attachment`
App: the paperclip on the assistant's composer, and files pasted or dropped on it

## Intent

Store one file a person attaches to a message for the in-app assistant, before the message is sent (#4690, ADR-222). The call returns the file's `gen_` id. The message then names the file in [`ask_assistant`](assistant.ask.md)'s `attachments`, and the turn reads the stored bytes back and hands them to the model.

The file belongs to the person who uploaded it. Only that person can attach it to a turn or read it back, and only in the workspace it was uploaded to.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `name` | string | yes | 1 to 200 characters, trimmed; the name the person's device gave the file. It is shown, and nothing reads a type from it |
| `mediaType` | string | yes | 1 to 127 characters; the type the device declared. The server checks it against the bytes |
| `data` | string | yes | the file's bytes, base64; at most 4 MiB once decoded |

## Output

| Field | Type | Description |
|---|---|---|
| `publicId` | string | `gen_…`, the id `ask_assistant`'s `attachments` takes |
| `name` | string | the name as sent |
| `mediaType` | string | the type the bytes carry. A PNG declared as `image/jpeg` is stored and returned as `image/png` |
| `sizeBytes` | integer | the decoded size |
| `sha256` | string | the SHA-256 of the bytes, hex |

## Behavior

1. The types allowed are images (PNG, JPEG, WebP, GIF), PDF, and text (plain, Markdown, CSV, JSON).
2. An image or a PDF must start with its format's signature. A text file must decode as UTF-8 and hold no NUL byte, and a JSON file must parse. A file that fails is refused and nothing is stored.
3. An image or a PDF can be up to 4 MiB, and a text file up to 256 KiB.
4. The bytes go to blob storage under `attachments/<org>/<workspace>/`. The row in `generated_assets` records the name, the type, the size, the SHA-256 and the storage key, with `source = user_upload` and `access_policy = user`. ClickHouse and the message rows keep no bytes.
5. The file is linked to a conversation and a message when a turn sends it. A file still unlinked 24 hours after upload was never sent. The hourly sweep `assistant.attachment-sweep` deletes its bytes, then its row. A file the store refuses to delete keeps its row until a later run succeeds.
6. The API route shares the chat route's rate budget under its own limiter key.
7. The composer gives up an upload after 60 seconds and shows the chip as failed, so a stalled request cannot hold the send button.
8. A sent message's chip links to the stored file through the read route, and opens it in a new tab.

When a turn sends files, `ask_assistant` checks them again before anything is written: at most 10 files, images and PDFs together at most 4 MiB, text together at most 256 KiB, and a model that can read each image and PDF. Text files are added to the message the model reads, so every model reads them.

## Errors

| Code | Status | When |
|---|---|---|
| `attachment_refused` (reason `type_not_allowed`) | 400 | the type is not on the list |
| `attachment_refused` (reason `too_large`) | 400 | the file is empty or over its type's cap |
| `attachment_refused` (reason `bytes_do_not_match_type`) | 400 | the bytes do not carry the declared type's signature, the text is not UTF-8, the JSON does not parse, or `data` is not base64 |
| `validation_error` | 400 | a field is missing or out of range |
| `bad_request` | 413 | the request body is larger than the base64 cap plus 16 KiB; the route refuses it before reading it |
| `forbidden` (reason `no_principal`) | 403 | no person signed the request |
| `forbidden` (reason `org_role_required`) | 403 | the person holds none of the contract's roles |

The 400 body is `{ error: { code: "attachment_refused", reason, message }, requestId }`. The message says what to change in words a person can act on.
