# ADR-196: A run's images are frame bodies in the evidence store

- **Status:** Accepted
- **Date:** 2026-09-26
- **Owners:** platform
- **Related:** ADR-042 (tenant data planes), ADR-058 (where the run record and
  its bodies live), ADR-195 (the seal signs its figures), issue #3608.

## Context

A run that browses, renders, or captures a screen produces images, and the
Run page's outputs spine reserves a `media` node for them
(`get_run_outputs`, `packages/oxagen/src/contracts/run.outputs.get.ts`). No
store holds the bytes. `tacho.session_files` records a path, counts and
digests, so a screenshot a session wrote to disk is a row with no bytes. No
frame kind carries an image, no retention class covers one, and a frame body
is capped at `TACHO_MAX_BODY_BYTES`, 1 MiB, which refuses most full-screen
screenshots.

A run's screenshots are customer content: a browser page, a terminal, a
document on screen. Where they live, how long they are kept, and how large
one may be are data-residency rules, so they are decided here before any
capture path is built.

## Decision

### 1. Where the bytes live

An image is a frame body. It is written through the evidence store
(`packages/run-ledger/src/evidence-store.ts`) exactly as a model or tool body
is: content-addressed by the sha256 of its bytes, encrypted in an
`@oxagen/crypto` envelope with a fresh data key, under an object key that
names the organization and workspace first, and referenced as
`evb:v1:<key id>:<sha256 hex>`. The reference routes by key id, so an image
moves to the organization's own plane and key when ADR-042 gains a blob plane,
with no change to the frame. No new table holds image bytes or keys. Erasing
an organization's key erases its images with every other body, and the hash
chain and the seal stay intact.

### 2. Retention

A new retention content class, `media`, is added to
`RETENTION_CONTENT_CLASSES` in `@oxagen/run-ledger` and to
`RETENTION_CLASS_BY_KIND` in `@oxagen/tacho` together, because
`retention.test.ts` holds the two tables in step. An image's bytes are kept
only when the run's pinned retention policy lists `media`. The platform's
default policy does not, so a workspace opts in before any image is stored.
The clock is the pinned policy's `ttl_days`, the clock every exact payload
runs on. The image's digest, type, size and dimensions stay on the frame after
the bytes expire, as every other body's digest does.

### 3. Size ceiling and refusal

- One image may be at most 8 MiB (8,388,608 bytes), and an attempt may keep
  at most 256 images.
- Only raster types are kept: `image/png`, `image/jpeg`, `image/webp` and
  `image/gif`. SVG is refused, because it is a document that can carry script,
  not a picture.
- An image over the ceiling, past the count, of a type not listed, or with a
  header that does not parse is refused. The frame still lands with the
  digest, the type and the size the producer reported, and a `refused` reason
  (`too_large`, `too_many`, `type_not_allowed` or `unreadable`). The seal
  records the new completeness gap `media_refused`.
- An image is never truncated, downscaled or re-encoded. A changed image would
  not hash to the digest the producer reported.
- `media_refused` does not block a replay rung on its own. An image that was a
  tool's result is also a tool body, so its refusal already records
  `tool_bodies`, and that gap blocks `fork` as it does today.

### 4. Capture shape

A new frame kind carries one image: `media_captured` on the tacho wire and
`media.captured` in the ledger registry. Its payload holds the digest, the
media type, the byte count, the width and height, and the frame that produced
it (the tool call's `tool_use_id`, or the model response). Width and height
are read from the image's header at capture, never by decoding the whole
image.

### 5. The read

A read returns a reference, never bytes inline. `get_run_outputs` gives a
media node `{ digest, mediaType, bytes, width, height }`. A new capability,
`get_run_media`, takes the run and the digest, checks the caller's tenant
scope and roles, and returns a signed URL that expires after 15 minutes, the
lifetime `get_run_export` gives a bundle's download. The app fetches it
through a typed route target (INV-13), never a raw URL, and each URL issued is
an audited read.

### 6. First capture path

The first producer is Claude Code: an image block in a tool result, the shape
a browser or screenshot tool returns, read by the tacho tailer and hook. Other
harnesses follow once this path holds.

## Consequences

- No image is stored until a workspace lists `media` in its retention policy.
- The data-residency rule for an image is the rule for every other body. A
  reader of ADR-058 already knows where a screenshot lives.
- A refused image leaves a frame that says what was refused and why, and the
  seal names the gap. The record never silently drops a capture.
- The Run page can draw a thumbnail at the image's real dimensions without
  fetching its bytes first.
- This ADR builds nothing. The capture path needs a real harness on a real Mac,
  and the read needs the capture path. Both are tracked on #3608.

## Alternatives considered

- **A media table with object keys.** It is a second place for tenant content
  with its own retention and erasure rules, where the evidence store already
  has both.
- **Raise `TACHO_MAX_BODY_BYTES` for every body.** It would widen the ceiling
  for model and tool text, which a megabyte already covers, to fit images.
- **Downscale large images at capture.** A downscaled image is not the one the
  agent saw, and its digest is not the producer's.
- **Return bytes inline.** An 8 MiB image in a capability response costs every
  caller the bytes whether it draws them or not, and puts customer content in
  API logs.
