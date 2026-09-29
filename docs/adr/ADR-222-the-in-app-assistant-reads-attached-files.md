# ADR-222: The in-app assistant reads attached files

- **Status:** Proposed
- **Date:** 2026-09-28
- **Owners:** app, agent, api
- **Decided by:** Mac asked for attachments on the in-app agent on 2026-09-28
  (#4690). The details below were chosen under SCR-002 and await acceptance.
- **Related:** issue #4690, issue #4179 (the assistant's composer), ADR-053
  (the in-app agent runs on stella-serve), ADR-092 (a turn outlives its
  stream), and the shadcn `attachment` component
  (https://ui.shadcn.com/docs/components/base/attachment)

## Context

A person asking the in-app assistant about a screenshot, an invoice, or a
CSV export had to describe the file in words. Most models the assistant runs
on read images, and several read PDFs. The turn had no way to hand them one.

Three questions had to be settled. Where the bytes live between the pick and
the send. How a file reaches a model that reads it, and what happens with a
model that does not. And who can read a file once it is stored.

## Decision

1. **A file is uploaded before the message is sent.** The new capability
   `upload_assistant_attachment` (surfaces `api` and `mcp`) takes one file as
   base64 and returns a `gen_` id. `ask_assistant` gains an optional
   `attachments` list of those ids. The chat stream route passes the list
   through. The message body stays small, and a failed upload shows on its
   own chip before the person sends anything.
2. **The bytes are checked, not the name.** One function,
   `checkAttachmentBytes` in `@oxagen/agent`, runs at upload and again when
   the turn reads the file. An image or a PDF must carry its format's
   signature, and the signature wins over the declared type. Text must decode
   as UTF-8 with no NUL byte, and JSON must parse. The types are PNG, JPEG,
   WebP, GIF, PDF, plain text, Markdown, CSV and JSON.
3. **The caps are contract constants.** An image or a PDF is at most 4 MiB,
   and a text file at most 256 KiB. A message carries at most 10 files, images
   and PDFs together at most 4 MiB, and text together at most 256 KiB. The app
   reads the same constants, so the composer refuses what the server would.
4. **Storage reuses `generated_assets`.** The row carries `source =
   user_upload`, `access_policy = user`, the SHA-256 and the name. The bytes go
   to blob storage under `attachments/<org>/<workspace>/`. When a turn sends
   the file, the row is linked to the conversation and the person's message.
   No migration is needed. ClickHouse and the message rows keep no bytes.
   A file still unlinked 24 hours after upload was never sent. The hourly
   Inngest cron `assistant.attachment-sweep` deletes its bytes, then its row.
   Each batch locks its rows with `FOR UPDATE SKIP LOCKED`, so a turn that
   links a file mid-sweep waits and then links nothing. A blob the store
   refuses to delete keeps its row for the next run. Deleting a conversation
   soft-deletes the rows of its sent files in the same transaction, so the
   read route refuses them from then on (#4690).
5. **Only the uploader reads a file, and only in its workspace.** The turn
   looks files up by public id, organisation, workspace, uploader, source and
   status together. The read route `GET
   /v1/:org/:ws/assistant/attachments/:publicId` reuses
   `serveGeneratedAsset`, whose `user` policy now also requires the
   organisation and workspace to match. Before this change, a creator's
   `user` asset could be read through another organisation's route.
6. **The model gets each type the way it reads best.** Images and PDFs reach
   the model as parts of the person's message (`userParts` on the governed
   turn). Text files are added to the instruction inside
   `<attachment name="…" type="…">` blocks, so every model reads them. The
   saved user message keeps what the person typed.
7. **A turn the model cannot serve is refused before anything is written.**
   An image needs a model `supportsVision` accepts. A PDF also needs a
   provider on `PDF_INPUT_PREFIXES` (Anthropic, OpenAI, Google). A refusal is
   `attachment_refused` with a reason, a 400 on the JSON routes and an error
   event on the stream, and its message says what to change.
8. **Uploads share the chat route's rate budget** under their own limiter
   key, so a burst of uploads cannot starve the questions.
9. **The composer uses a local port of the shadcn `attachment` component**
   at `apps/app/src/ui/attachment.tsx`, with no new dependency. A person
   attaches by the paperclip, by paste, or by drop. Each chip shows the
   file's kind and size as two separate elements, never joined by
   punctuation.
   The composer gives up an upload after 60 seconds and marks the chip
   failed, so a stalled request cannot hold the send button. A sent
   message's chip links to the stored file through the read route and opens
   it in a new tab.

## Consequences

- A person can ask about a screenshot, a PDF or a data file in one message.
- A file that fails a rule is refused with a reason the person can act on, at
  upload when the file alone breaks it, and at send when the set does.
- The capability, its route, its MCP tool and its doc follow the usual
  parity checks. The agent surface does not list it: a person attaches a
  file, the model does not.
- A 4 MiB file is about 5.6 MB as base64. The upload route reads at most
  that plus 16 KiB and answers 413 past it, before buffering the body. The
  app's proxy allows 10 MB.
- An agent test that mocks `@oxagen/ai` without `supportsVision` fails only
  when the turn carries an image or a PDF.

Deferred, with no issue until one is needed:

- Earlier turns' files are not sent again on a later turn. The model sees a
  file on the turn it was sent with.
- The app does not downscale a large image before upload.
- "Ask again" after a refusal resends the text without the files.

## Alternatives considered

- **Send the bytes inside the `ask_assistant` body.** One request instead of
  two, but a refused file would fail the whole question, a 4 MiB image would
  ride every retry, and the stream route would carry megabytes it only passes
  through.
- **A new attachments table.** `generated_assets` already carries the owner,
  the scope, the storage key, the type, the size, the soft delete and the
  conversation link. A second table would duplicate each of them and need a
  migration.
- **Send text files as file parts.** Not every provider reads a text file
  part, and a model that cannot would refuse the turn. Inlining reaches every
  model.
- **Trust the declared type.** A file named `.png` that holds anything else
  would reach the model as noise, or reach a parser it was not meant for.
