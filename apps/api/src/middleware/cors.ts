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
function allowedOrigins(): Set<string> {
  const origins = [process.env.APP_URL, process.env.NEXT_PUBLIC_APP_URL];
  if (!isProductionRuntime()) {
    origins.push("http://localhost:3000");
  }
  return new Set(
    origins
      .filter((url): url is string => Boolean(url))
      .map((url) => url.replace(/\/$/, "")),
  );
}

export const corsMiddleware: MiddlewareHandler<AppEnv> = (c, next) => {
  // Resolved per request so env changes (and per-test overrides) take effect
  // without module reloads; the closure cost is negligible.
  const allowed = allowedOrigins();
  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  })(c, next);
};
