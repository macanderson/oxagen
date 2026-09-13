import path from "node:path";
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

export default getRequestConfig(() => ({
  locale: DEFAULT_LOCALE,
  messages: messages(),
}));
