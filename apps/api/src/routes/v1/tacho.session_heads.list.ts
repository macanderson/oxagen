import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { tachoSessionHeadsList } from "@oxagen/oxagen/contracts/tacho.session_heads.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Which of a batch of sessions the control plane already holds for the
 * calling host, asked by `oxagen agent backfill` before it seals anything
 * (ADR-161).
 *
 * Machine-to-machine: the host's API key carries its org and workspace, so
 * this route lives on the static /v1/tacho router and refuses anything but an
 * API key before it reads the body.
 */
// The contract admits 500 uuids of 36 ASCII characters and 500 harness
// session ids of at most 128 characters from a set JSON writes unescaped:
// about 85 KiB with quotes and commas. 128 KiB leaves room for the rest.
// tacho.host-routes.ts mounts routes by this limit.
const MAX_BODY_BYTES = 128 * 1024;

export const tachoSessionHeadsListRoute = new Hono<AppEnv>();

tachoSessionHeadsListRoute.use("*", async (c, next) => {
  if (!c.get("apiKeyId")) {
    throw new HTTPException(401, { message: "API key required" });
  }
  await next();
});

tachoSessionHeadsListRoute.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new HTTPException(413, { message: "Payload Too Large" });
    },
  }),
);

tachoSessionHeadsListRoute.post("/sessions/heads", async (c) => {
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

  const input = tachoSessionHeadsList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(tachoSessionHeadsList.name, input, ctx, {
    surface: "api",
  });
  c.header("Cache-Control", "no-store");
  return c.json(output);
});
