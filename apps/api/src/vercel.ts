import { handle } from "@hono/node-server/vercel";
import { app } from "./app";
import { bootstrap } from "./bootstrap";

// Vercel serverless entrypoint. build.mjs esbuild-bundles this into
// .vercel/output/functions/api.func/index.cjs (Build Output API); config.json
// routes every path here and Hono does the routing for the whole app
// (/health, /webhooks/stripe, /api/inngest, /v1/*). Node runtime (NOT edge):
// pg / Neo4j / ClickHouse / Better Auth all need Node APIs.
//
// Wire env validation + IAM enforcement + the SOC2 audit emitter once per cold
// start, before any request is handled. bootstrap() is async (it awaits
// assertRlsConnectionSafe), but the esbuild CJS output forbids top-level await —
// so we kick it off at module load and await the memoized promise inside the
// handler. The first request waits for bootstrap to finish; a failed RLS guard
// rejects the request (refuse to serve) rather than silently running unguarded.
const ready = bootstrap();
const honoHandler = handle(app);

export default async function handler(
  ...args: Parameters<typeof honoHandler>
): Promise<ReturnType<typeof honoHandler>> {
  await ready;
  return honoHandler(...args);
}
