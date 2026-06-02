import { handle } from "@hono/node-server/vercel";
import { app } from "../src/app";
import { bootstrap } from "../src/bootstrap";

// Vercel serverless entrypoint for the API. The whole Hono `app` (root-level
// routes: /health, /webhooks/stripe, /api/inngest, /v1/*) is served by this one
// function; `vercel.json` rewrites every path here so Hono does the routing.
//
// Node runtime (NOT edge): Postgres (pg), Neo4j bolt, ClickHouse, and Better
// Auth all need Node APIs. `maxDuration` covers synchronous agent/LLM routes;
// long-running work is dispatched async via Inngest, never held on the request.
export const config = { maxDuration: 60 };

// Wire env validation + IAM enforcement + the SOC2 audit emitter once per cold
// start, before any request is handled. Idempotent.
bootstrap();

export default handle(app);
