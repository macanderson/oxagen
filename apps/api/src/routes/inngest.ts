import { Hono } from "hono";
import type { AppEnv } from "../app.js";

// The Inngest serve() handler lives in apps/runner, which is the only
// process registered with Inngest cloud. apps/api emits events via the
// Inngest client when needed; the actual serve endpoint is not mounted
// here to keep one writer of function manifests. This stub is reserved
// for future locally-mounted dev tooling.
export const inngestRoute = new Hono<AppEnv>();

inngestRoute.all("/*", (c) =>
  c.json(
    {
      error: {
        code: "not_implemented",
        message: "Inngest serve handler lives at apps/runner /api/inngest",
      },
    },
    501,
  ),
);
