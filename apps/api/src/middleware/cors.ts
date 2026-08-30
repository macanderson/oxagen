import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import { isProductionRuntime } from "@oxagen/config/env";
import type { AppEnv } from "../app";

/**
 * Browser CORS for cross-origin app → API fetches.
 *
 * apps/app client components (connection wizard, connector forms, graph
 * inference UI) fetch this API directly from the browser — localhost:3000 →
 * localhost:4000 in dev, separate domains in deployed envs — so every call
 * is cross-origin and JSON POST/PUT bodies trigger a preflight. Without
 * these headers the browser aborts with "Failed to fetch" before any route
 * runs. Origins come from env, never hard-coded, so the oxagen.ai cutover
 * stays a pure env-var sweep.
 *
 * The app authenticates with the Better Auth session cookie
 * (credentials: "include"), and the fetch spec forbids a wildcard origin
 * with credentials — so the allowlist echoes the exact origin or nothing.
 *
 * SECURITY: http://localhost:3000 is trusted ONLY in non-production runtimes.
 * A production API that trusts localhost lets any page a victim runs locally
 * (or any attacker-controlled dev server bound to that port) make
 * credentialed cross-origin calls with the victim's session cookie. In prod
 * the allowlist is exactly the configured APP_URL / NEXT_PUBLIC_APP_URL.
 */
/**
 * The marketing site is reachable at both the apex and www hosts (Vercel
 * 308-redirects one to the other, but a visitor's Origin header carries
 * whichever host they loaded), so a single configured MARKETING_URL must
 * allow both. Applied ONLY to the marketing origin — the app origin is a
 * single canonical host and gets no twin.
 */
function withWwwTwin(origin: string): string[] {
  try {
    const url = new URL(origin);
    const twinHost = url.hostname.startsWith("www.")
      ? url.hostname.slice(4)
      : `www.${url.hostname}`;
    return [
      origin,
      `${url.protocol}//${twinHost}${url.port ? `:${url.port}` : ""}`,
    ];
  } catch {
    return [origin];
  }
}

function allowedOrigins(): Set<string> {
  const origins = [process.env.APP_URL, process.env.NEXT_PUBLIC_APP_URL];
  // The public marketing website (oxagen.sh / www.oxagen.sh) calls the
  // /v1/cms/* lead routes cross-origin from the browser. In prod that origin
  // must be explicitly allowed; MARKETING_URL carries it.
  const marketing = process.env.MARKETING_URL?.replace(/\/$/, "");
  if (marketing) {
    origins.push(...withWwwTwin(marketing));
  }
  if (!isProductionRuntime()) {
    origins.push("http://localhost:3000");
  }
  return new Set(
    origins
      .filter((url): url is string => Boolean(url))
      .map((url) => url.replace(/\/$/, "")),
  );
}

// The static marketing site can be served from any localhost port during local
// development (a preview server, `python -m http.server`, etc.), so in
// non-production we additionally echo any localhost/127.0.0.1 origin. This is
// gated on non-production exactly like the localhost:3000 allowance above — a
// production API never trusts localhost.
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
function isAllowedOrigin(origin: string): boolean {
  if (allowedOrigins().has(origin)) return true;
  if (!isProductionRuntime() && LOCALHOST_ORIGIN.test(origin)) return true;
  return false;
}

export const corsMiddleware: MiddlewareHandler<AppEnv> = (c, next) => {
  // Resolved per request so env changes (and per-test overrides) take effect
  // without module reloads; the closure cost is negligible.
  return cors({
    origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  })(c, next);
};
