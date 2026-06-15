import { handle } from "@hono/node-server/vercel";
import { app } from "./app";
import { bootstrap } from "./bootstrap";

// Vercel serverless entrypoint. build.mjs esbuild-bundles this into
// .vercel/output/functions/api.func/index.cjs (Build Output API); config.json
// routes every path here and Hono does the routing for the whole app
// (/health, /webhooks/stripe, /api/inngest, /v1/*). Node runtime (NOT edge):
// pg / Neo4j / ClickHouse / Better Auth all need Node APIs.
//
// Wire env validation + IAM enforcement + the SOC2 audit emitter before any
// request is served. bootstrap() is memoized and self-healing: the first call
// runs the work, later calls await the same promise, and a transient cold-start
// failure clears the memo so the next request retries instead of wedging the
// instance.
//
// We AWAIT bootstrap() INSIDE the handler (never as a floating module-scope
// promise). A bare `const ready = bootstrap()` would leave the rejection
// UNHANDLED until the first request attaches `await ready`; if bootstrap rejects
// on a cold start (env validation, assertRlsConnectionSafe, or the DB briefly
// unreachable) before that request arrives, Node raises `unhandledRejection`,
// which Vercel reports as "Unhandled Rejection" and converts into
// FUNCTION_INVOCATION_FAILED — tearing the whole instance down with an opaque
// 500 (the original symptom on POST /v1/.../connections and the GitHub App
// webhook). Awaiting inside the try/catch keeps the rejection contained and
// turns a boot failure into a clean 503.
const honoHandler = handle(app);

// Kick off bootstrap during cold-start init so the first request doesn't pay the
// whole cost. The no-op `.catch` is REQUIRED: this is a fire-and-forget call, so
// without it a rejection here would surface as an unhandledRejection and crash
// the function. The handler's own `await bootstrap()` below re-attempts (memo
// cleared on failure) and surfaces the real error per request.
void bootstrap().catch(() => undefined);

export default async function handler(
  req: Parameters<typeof honoHandler>[0],
  res: Parameters<typeof honoHandler>[1],
): Promise<void> {
  try {
    await bootstrap();
  } catch {
    // Cold-start initialization failed. Return a clean, explicit 503 instead of
    // letting the rejection crash the function with FUNCTION_INVOCATION_FAILED.
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: {
          code: "service_unavailable",
          message: "API failed to initialize — check server configuration.",
        },
      }),
    );
    return;
  }
  await honoHandler(req, res);
}
