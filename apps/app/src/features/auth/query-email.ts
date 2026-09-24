// An address a sign-in page shows back to the person who typed it: Verify
// email's lead, and the sign-up form it returns to through Change it. It is
// never looked up, so a malformed value is simply not echoed.
import { firstParam } from "@/shared/safe-path";

const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

/** The trimmed `?email=` value when it has the shape of an address, otherwise null. */
export function queryEmail(
  value: string | string[] | undefined,
): string | null {
  const raw = firstParam(value)?.trim() ?? "";
  return EMAIL_SHAPE.test(raw) ? raw : null;
}
