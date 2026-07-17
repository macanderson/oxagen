/**
 * Pure parsing helper for the composer's `attachments` FormData field.
 *
 * Lives in its OWN module (not the sibling `actions.ts`, which is
 * `"use server"`) on purpose: a `"use server"` module may only export async
 * functions, which would force this helper to return a Promise. Its sole
 * caller — `sendMessageAction`'s synchronous `FormSchema.safeParse({ … })` —
 * needs the parsed value inline, so an accidental Promise slips straight past
 * `z.array()` as `received: "promise"` and fails the whole send with
 * "Invalid message" (regression from #589). Keeping it a plain synchronous
 * function is the fix and matches the unit tests, which assert a sync return.
 */

/**
 * Parse the composer's `attachments` FormData field — a JSON-serialized array
 * (message-composer.tsx `fd.set("attachments", JSON.stringify(...))`) — into a
 * plain `unknown` value ready for `FormSchema.safeParse`. Malformed or absent
 * JSON degrades to `[]` (no attachments) rather than failing the whole message
 * send; exported standalone so the parsing/degradation behavior is
 * unit-testable without a DB.
 */
export function parseAttachmentsField(
  raw: FormDataEntryValue | undefined,
): unknown {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
