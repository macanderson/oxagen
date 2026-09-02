import { constantTimeStringEqual } from "../safe-compare";

// Google push notifications (Drive/Calendar/Gmail watch channels) do NOT carry an
// HMAC signature. Instead, the value passed to `channel.token` at watch-creation
// time is echoed back verbatim on every delivery in the `X-Goog-Channel-Token`
// header. The security boundary is therefore a constant-time comparison of that
// header against the per-connection channel secret stored at subscription time.
//
// This fails CLOSED: a missing secret, a missing header, or a mismatch all reject.
export function verifyGoogleChannelToken(
  headers: Record<string, string>,
  secret: string | null,
): boolean {
  if (!secret) return false;
  // Header map is lowercased by the route before this runs.
  const token = headers["x-goog-channel-token"];
  if (typeof token !== "string" || token.length === 0) return false;
  return constantTimeStringEqual(token, secret);
}
