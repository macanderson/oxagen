/**
 * api-error.ts — read a human-readable message out of a failed API response.
 *
 * The Hono API answers a failed request in one of two shapes. A route that
 * refuses a request itself writes `{ error: "text" }`. Anything that throws
 * reaches the error middleware (apps/api/src/middleware/error.ts), which writes
 * `{ error: { code, message }, requestId }`. A client that reads `body.error`
 * as a string shows "[object Object]" for the second shape, which is what the
 * GitHub connect dialog showed while the status route was failing with a 500.
 *
 * The request id rides along in the message when the server sent one, so the
 * text a person copies out of the dialog is the same key that finds the
 * server-side log line.
 */

interface ErrorEnvelope {
  error?: unknown;
  requestId?: unknown;
}

/**
 * Return the message an API error body carries, or `fallback` when the body
 * carries none the client can show. Never returns "[object Object]".
 */
export function apiErrorMessage(body: unknown, fallback: string): string {
  if (body === null || typeof body !== "object") return fallback;
  const { error, requestId } = body as ErrorEnvelope;

  let message: string | null = null;
  if (typeof error === "string" && error.trim() !== "") {
    message = error;
  } else if (error !== null && typeof error === "object") {
    const nested = (error as { message?: unknown }).message;
    if (typeof nested === "string" && nested.trim() !== "") {
      message = nested;
    }
  }
  if (message === null) return fallback;

  return typeof requestId === "string" && requestId !== ""
    ? `${message} (request ${requestId})`
    : message;
}
