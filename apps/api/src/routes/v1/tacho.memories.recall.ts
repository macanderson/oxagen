import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { tachoMemoriesRecall } from "@oxagen/oxagen/contracts/tacho.memories.recall";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * The memories most relevant to one prompt on the calling host (ADR-206).
 *
 * Machine-to-machine: the host's API key carries its org and workspace, so
 * this route lives on the static /v1/tacho router and refuses anything but an
 * API key before it reads the body.
 */
// The contract admits 64 tools of 200 UTF-16 code units, 64 paths of 512, a
// prompt of 8,000, and 8 repository digests of 71 ASCII characters. JSON
// writes one code unit as at most 6 bytes (a `\u` escape), so those fields
// fit in 321,976 bytes and 384 KiB leaves room for the rest of the body.
// tacho.host-routes.ts mounts routes by this limit.
const MAX_BODY_BYTES = 384 * 1024;

export const tachoMemoriesRecallRoute = new Hono<AppEnv>();

tachoMemoriesRecallRoute.use("*", async (c, next) => {
  if (!c.get("apiKeyId")) {
    throw new HTTPException(401, { message: "API key required" });
  }
  await next();
});

tachoMemoriesRecallRoute.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new HTTPException(413, { message: "Payload Too Large" });
    },
  }),
);

tachoMemoriesRecallRoute.post("/memories/recall", async (c) => {
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

  const input = tachoMemoriesRecall.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(tachoMemoriesRecall.name, input, ctx, {
    surface: "api",
  });
  c.header("Cache-Control", "no-store");
  return c.json(output);
});
