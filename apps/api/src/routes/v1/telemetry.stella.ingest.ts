import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { telemetryStellaIngest } from "@oxagen/oxagen/contracts/telemetry.stella.ingest";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

const STELLA_OPERATIONAL_MAX_BODY_BYTES = 256 * 1024;

export const telemetryStellaIngestRoute = new Hono<AppEnv>();

telemetryStellaIngestRoute.use("*", async (c, next) => {
  if (!c.get("apiKeyId")) {
    throw new HTTPException(401, { message: "API key required" });
  }
  await next();
});

telemetryStellaIngestRoute.use(
  "*",
  bodyLimit({
    maxSize: STELLA_OPERATIONAL_MAX_BODY_BYTES,
    onError: () => {
      throw new HTTPException(413, { message: "Payload Too Large" });
    },
  }),
);

telemetryStellaIngestRoute.post("/operational", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = telemetryStellaIngest.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(telemetryStellaIngest.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
