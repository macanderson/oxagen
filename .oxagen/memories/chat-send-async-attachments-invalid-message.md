---
name: chat-send-async-attachments-invalid-message
type: bug
domain: app-chat
severity: P1
linear: none
date: 2026-07-04
---

**Symptom:** e2e `chat-tool-io-structured.spec.ts` ("research.swarm.start input/result render as labeled key/value") timed out waiting for `[data-component="tool-call-card"]`. The CI DOM snapshot showed `paragraph: "Invalid message"` under the composer and the network trace had **no** `POST /api/v1/chat/stream` at all — the send short-circuited. Every text-only `/ask` (and `/chat`→`/ask`) message send was broken, not just this spec.

**Root cause:** `parseAttachmentsField` in `apps/app/src/app/[orgSlug]/[workspaceSlug]/ask/actions.ts` was declared `async` (introduced by #589). Because `actions.ts` is a `"use server"` module, **every export must be async** — so the helper was forced to return a `Promise`. Its sole caller passes the result straight into a *synchronous* `FormSchema.safeParse({ …, attachments: parseAttachmentsField(...) })` without `await`, so `z.array()` saw `received: "promise"`, failed, and `sendMessageAction` returned `{ ok: false, error: "Invalid message" }`. `wrappedSendAction` then returned before ever fetching the SSE stream → no streamed turn, no tool-call card. The helper's own unit tests were also red on main for the same reason (they assert a synchronous `.toEqual([])`).

**Fix:** moved the pure helper out of the `"use server"` file into a plain module `apps/app/src/app/[orgSlug]/[workspaceSlug]/ask/parse-attachments.ts` and made it **synchronous** (`export function … : unknown`, plain `JSON.parse`). Updated the import in `actions.ts` and the test. No caller change needed — the un-awaited call now returns the array directly.

**Guard:** `actions.test.ts` — the existing `parseAttachmentsField` tests fail on the old async code (Promise ≠ []), plus a new regression test asserts the return is never a thenable and validates against the same `z.array(...).max(8).default([])` shape the send action uses.

**Watch-outs:**
- A `"use server"` file may ONLY export async functions. Do NOT put a pure sync helper there and "fix the type error" by adding `async` — its callers likely use it synchronously. Put pure helpers in a sibling non-`"use server"` module.
- An un-awaited async call flowing into a synchronous `zod.safeParse` fails silently as `received: "promise"` and surfaces as a generic user-facing validation error — grep for `parse*(...)` calls inside `safeParse({...})` object literals.
