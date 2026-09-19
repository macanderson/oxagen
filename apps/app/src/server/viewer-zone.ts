// The zone a write resolves a picked calendar day in.
//
// `<input type="date">` hands over a bare `YYYY-MM-DD`, and the app draws every
// date in the viewer's zone, so that day is a day in their zone. Turning it into
// an instant therefore needs the zone, and a write that stores an authority
// boundary needs the *right* zone rather than a plausible one.
//
// Both mandate writes read it through here rather than each doing its own read
// and its own fallback. Two copies of this decision is how the grant path and
// the change-limits path come to disagree about what a picked day means.
import { userPreferencesRead } from "@oxagen/oxagen/contracts/user.preferences.read";
import type { PageKey } from "@/data/read";
import { supportsTimeZone } from "@/shared/calendar-day";
import type { ActionResult } from "./kernel";
import { kernelRead } from "./kernel";
import type { OrgCtx } from "./viewer";

/** The zone, or the refusal a write should answer with instead of guessing. */
export type ViewerZone =
  | { ok: true; timeZone: string }
  | Exclude<ActionResult<never>, { ok: true }>;

/**
 * The viewer's zone, or a refusal.
 *
 * **A failed read refuses; it does not fall back.** Pages fall back to Pacific
 * when this read fails, because a date drawn in the wrong zone is a cosmetic
 * error a reader can see. A *boundary* written in the wrong zone is not: for an
 * operator in Tokyo, Pacific moves the end of their day 17 hours later, which is
 * authority nobody granted, and nothing on screen afterwards says the zone was
 * guessed. When being wrong is not symmetric, take the side that cannot grant
 * more than was asked for. A refusal here is retryable and visible; the widened
 * window would have been neither.
 *
 * A stored zone this runtime cannot format in refuses for the same reason and
 * says so differently, because retrying will not help: that one needs the person
 * to store a zone this runtime knows.
 */
export async function viewerTimeZone(
  ctx: OrgCtx,
  page: PageKey,
): Promise<ViewerZone> {
  const preferences = await kernelRead(ctx, {
    contract: userPreferencesRead,
    input: {},
    page,
  });
  if (!preferences.ok) {
    return { ok: false, reason: "unavailable", code: "timezone_unavailable" };
  }
  const stored = preferences.value.timezone;
  if (!supportsTimeZone(stored)) {
    return { ok: false, reason: "conflict", code: "timezone_unsupported" };
  }
  return { ok: true, timeZone: stored };
}
