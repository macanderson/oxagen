import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/** Bind browser requests to this loopback listener and process. */
export function requestAuth(origin: string, token: string): MiddlewareHandler {
  const host = new URL(origin).host;
  const expected = Buffer.from(`Bearer ${token}`);
  return async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header(
      "Content-Security-Policy",
      "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    c.header("X-Content-Type-Options", "nosniff");
    if (c.req.header("host") !== host || new URL(c.req.url).origin !== origin) {
      return c.json({ error: "Invalid local host" }, 403);
    }
    const requestOrigin = c.req.header("origin");
    const fetchSite = c.req.header("sec-fetch-site");
    if (
      (requestOrigin !== undefined && requestOrigin !== origin) ||
      (fetchSite !== undefined &&
        fetchSite !== "same-origin" &&
        fetchSite !== "none")
    ) {
      return c.json({ error: "Cross-origin requests are refused" }, 403);
    }
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
      const actual = Buffer.from(c.req.header("authorization") ?? "");
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        return c.json(
          { error: "Open the current access link printed by env-manager" },
          401,
        );
      }
    }
    await next();
  };
}
