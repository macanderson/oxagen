import { timingSafeEqual } from "node:crypto";

// Shared constant-time string comparison for webhook verification boundaries
// (OXA-2051). Several connectors (Zoom's bearer token, Microsoft's clientState)
// compare an inbound secret against the stored one with plain `===`, which is a
// variable-time comparison and leaks information about the correct secret via
// response-time analysis (byte-by-byte guessing). node:crypto's timingSafeEqual
// closes that side channel, but it throws a RangeError on unequal-length
// buffers — that throw must NOT be allowed to propagate (it would either crash
// the handler or, worse, be swallowed by a surrounding catch into a false
// accept). Fails CLOSED on any length mismatch or unexpected error.
export function constantTimeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  try {
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}
