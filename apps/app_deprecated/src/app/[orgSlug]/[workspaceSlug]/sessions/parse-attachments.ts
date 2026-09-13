/**
 * Parse the composer's `attachments` FormData field — a JSON-serialized array
 * (message-composer.tsx `fd.set("attachments", JSON.stringify(...))`) — into a
 * plain `unknown` value ready for `FormSchema.safeParse`. Malformed or absent
 * JSON degrades to `[]` (no attachments) rather than failing the whole message
 * send.
 *
 * This helper MUST stay synchronous, and that is why it lives in its own module
 * rather than in the sibling `actions.ts`: a `"use server"` module may only
 * export async functions, and a Promise here would reach `z.array()` as
 * `received: "promise"` and fail every send with "Invalid message".
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
