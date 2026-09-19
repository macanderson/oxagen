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
 * So the zone stays out of here. Under `[org]`, which is the application,
 * `<ViewerClock>` reads the viewer's preference inside the layout's own
 * `<Suspense>`: client components get it through the provider it renders, and
 * server components through `@/ui/formatter`, which formats in the zone the
 * clock writes to a per-request slot. Outside `[org]` (the invitation page),
 * dates read in Pacific time, this default (#3368).
 */
export default getRequestConfig(() => ({
  locale: DEFAULT_LOCALE,
  messages: messages(),
  timeZone: DEFAULT_TIME_ZONE,
}));
