import path from "node:path";
import { DEFAULT_TIME_ZONE } from "@oxagen/oxagen/contracts/user.preferences.read";
import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, type Messages } from "./catalogs";
import { loadCatalogs } from "./load-catalogs";

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
 * This config carries no request data, and cannot.
 *
 * The root layout awaits `getTranslations`, so every route in the app resolves
 * this config, static ones included. Reading `cookies()` here therefore made
 * the whole app unprerenderable: under Cache Components a request read outside
 * `<Suspense>` does not throw, it aborts the prerender, and the build failed on
 * the first static route it reached (`/_not-found`). A try/catch cannot rescue
 * that, because nothing is thrown to catch.
 *
 * So the zone stays out of here, which is the design `[org]/layout.tsx`
 * already implements: `<ViewerClock>` reads the viewer's preference inside the
 * layout's own `<Suspense>` and hands it to next-intl through the client
 * provider. Everything under `[org]`, which is the application, renders in the
 * viewer's zone.
 *
 * What this leaves: a Server Component outside `[org]` that formats a date
 * through `getFormatter()` gets Pacific rather than the viewer's zone. The
 * invite page is the one that does (macanderson/oxagen#3368). Fixing it means
 * resolving the zone inside that route's own boundary and passing it to
 * `getFormatter({ timeZone })`, not moving the read back up here.
 */
export default getRequestConfig(() => ({
  locale: DEFAULT_LOCALE,
  messages: messages(),
  timeZone: DEFAULT_TIME_ZONE,
}));
