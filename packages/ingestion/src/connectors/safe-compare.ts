import { timingSafeEqual } from "node:crypto";

// Shared constant-time string comparison for webhook verification boundaries.
// A plain `===` comparison of an inbound secret against the stored one takes
// variable time and leaks information about the correct secret through
// response-time analysis (byte-by-byte guessing). node:crypto's
// timingSafeEqual closes that side channel, but it throws a RangeError on
// unequal-length buffers — that throw must not be allowed to propagate (it
// would either crash the handler or, worse, be swallowed by a surrounding
// catch into a false accept). Fails closed on any length mismatch or
// unexpected error.
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
