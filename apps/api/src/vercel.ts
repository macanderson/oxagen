import { handle } from "@hono/node-server/vercel";
import { app } from "./app";
import { bootstrap } from "./bootstrap";

// Source for the Vercel serverless function. `build.mjs` esbuild-bundles this
// into `api/index.mjs` (a single self-contained file) so the symlinked
// @oxagen/* workspace packages — which export raw .ts — are inlined rather than
// externalized (that externalization is what caused ERR_MODULE_NOT_FOUND).
//
// `vercel.json` rewrites every path to this one function; Hono does the routing
// for the whole app (/health, /webhooks/stripe, /api/inngest, /v1/*). Node
// runtime (NOT edge): pg / Neo4j / ClickHouse / Better Auth all need Node APIs.
//
// Wire env validation + IAM enforcement + the SOC2 audit emitter once per cold
// start, before any request is handled. Idempotent.
bootstrap();

export default handle(app);
