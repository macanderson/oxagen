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
// start, before any request is handled. Idempotent.
// bootstrap() is async (awaits assertRlsConnectionSafe before accepting traffic).
await bootstrap();

export default handle(app);
