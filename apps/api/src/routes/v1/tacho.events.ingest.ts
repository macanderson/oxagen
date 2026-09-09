import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { tachoEventsIngest } from "@oxagen/oxagen/contracts/tacho.events.ingest";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Ingest a batch of tacho/1.0 events from an enrolled host.
 *
 * Machine-to-machine: the host's API key carries its immutable org and
 * workspace scope, so this route lives on the static /v1/tacho router and
 * rejects anything but an API key before the body is read.
 */
const MAX_BODY_BYTES = 1048576;

export const tachoEventsIngestRoute = new Hono<AppEnv>();

tachoEventsIngestRoute.use("*", async (c, next) => {
  if (!c.get("apiKeyId")) {
    throw new HTTPException(401, { message: "API key required" });
  }
  await next();
});

tachoEventsIngestRoute.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new HTTPException(413, { message: "Payload Too Large" });
    },
  }),
);

tachoEventsIngestRoute.post("/events", async (c) => {
  const mediaType = c.req
    .header("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new HTTPException(415, {
      message: "Content-Type must be application/json",
    });
  }

  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = tachoEventsIngest.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(tachoEventsIngest.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
