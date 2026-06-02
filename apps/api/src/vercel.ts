import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "@hono/node-server/vercel";
import { app } from "./app";
import { bootstrap } from "./bootstrap";

// Vercel serverless entrypoint. build.mjs esbuild-bundles this into
// .vercel/output/functions/api.func/index.cjs; config.json routes every path
// here and Hono does the routing. Node runtime (pg/Neo4j/ClickHouse/Better Auth
// need Node, not edge).
//
// TEMP DIAGNOSTIC: capture a bootstrap() failure (e.g. loadEnv validation) and
// surface the full message in the response body instead of an opaque
// FUNCTION_INVOCATION_FAILED, so the exact offending env var is visible.
let bootError: string | null = null;
try {
  bootstrap();
} catch (e) {
  bootError = e instanceof Error ? (e.stack ?? e.message) : String(e);
}

const realHandler = handle(app);

export default bootError
  ? (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(`BOOTSTRAP_ERROR\n${bootError}`);
    }
  : realHandler;
