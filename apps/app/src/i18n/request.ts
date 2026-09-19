import path from "node:path";
import { DEFAULT_TIME_ZONE } from "@oxagen/oxagen/contracts/user.preferences.read";
import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, type Messages } from "./catalogs";
import { loadCatalogs } from "./load-catalogs";
import {
  resolveTimeZoneCookie,
  TIME_ZONE_COOKIE,
} from "@/shared/time-zone-cookie";

// messages/ sits beside package.json. `next dev`, `next start`, Vitest and
// Playwright all run from apps/app, and the standalone server.js chdirs to its
// own app directory, so process.cwd() resolves it in every runtime.
const MESSAGES_DIR = path.join(process.cwd(), "messages");

let cached: Messages | undefined;

/** Memoised in production; re-read in development so a new catalog appears on refresh. */
function messages(): Messages {
  if (process.env.NODE_ENV === "development") return loadCatalogs(MESSAGES_DIR);
  cached ??= loadCatalogs(MESSAGES_DIR);
  return cached;
}

/**
 * Zone for Server Components that call `useFormatter` / `getFormatter`.
 *
 * The preference itself stays out of this config: Cache Components prerenders
 * the static shell without person-specific DB reads. The zone rides the `tz`
 * cookie instead (set when the preference is shown or saved). A missing or
 * unusable cookie is Pacific time, the same default the store and the shell
 * fall back to.
 */
async function timeZoneFromCookie(): Promise<string> {
  try {
    const jar = await cookies();
    return resolveTimeZoneCookie(jar.get(TIME_ZONE_COOKIE)?.value);
  } catch {
    // Static shell prerender: no request cookie store yet.
    return DEFAULT_TIME_ZONE;
  }
}

export default getRequestConfig(async () => ({
  locale: DEFAULT_LOCALE,
  messages: messages(),
  timeZone: await timeZoneFromCookie(),
}));
