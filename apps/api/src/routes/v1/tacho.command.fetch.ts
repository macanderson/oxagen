import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { tachoCommandFetch } from "@oxagen/oxagen/contracts/tacho.command.fetch";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Acknowledge and fetch control commands for the calling host.
 *
 * Machine-to-machine: the host's API key carries its immutable org and
 * workspace scope, so this route lives on the static /v1/tacho router and
 * rejects anything but an API key before the body is read.
 */
const MAX_BODY_BYTES = 262144;

export const tachoCommandFetchRoute = new Hono<AppEnv>();

tachoCommandFetchRoute.use("*", async (c, next) => {
  if (!c.get("apiKeyId")) {
    throw new HTTPException(401, { message: "API key required" });
  }
  await next();
});

tachoCommandFetchRoute.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new HTTPException(413, { message: "Payload Too Large" });
    },
  }),
);

tachoCommandFetchRoute.post("/commands", async (c) => {
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

  const input = tachoCommandFetch.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(tachoCommandFetch.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
