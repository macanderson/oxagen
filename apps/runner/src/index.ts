import { Hono } from "hono";
import { serve as nodeServe } from "@hono/node-server";
import { serve as inngestServe } from "inngest/hono";
import { loadEnv } from "@oxagen/config/env";
import { PORTS } from "@oxagen/config";
import { inngest } from "./inngest.js";
import { functions } from "./index.functions.js";
import { logger } from "./logger.js";

loadEnv();

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

// Mounts the Inngest serve handler at /api/inngest. Inngest cloud polls
// this endpoint to introspect registered functions and to deliver event
// invocations; signing-key verification happens inside the handler.
app.on(["GET", "POST", "PUT"], "/api/inngest", (c) =>
  inngestServe({ client: inngest, functions })(c),
);

const port = PORTS.runner;
nodeServe({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port, functions: functions.length }, "runner listening");
});
