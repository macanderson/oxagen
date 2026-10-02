import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { workOrderClaim } from "@oxagen/oxagen/contracts/work.order.claim";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Claim a work order for the calling enrolled host before it starts a run,
 * and read the first prompt the run starts with (`claim_work_order`,
 * ADR-251).
 *
 * Machine-to-machine: the host's API key carries its org and workspace, so
 * this route lives on the static /v1/tacho router and refuses anything but an
 * API key before it reads the body.
 */
// A claim names one enrollment and one work order, under 200 bytes. 16 KiB
// leaves room and refuses a large body before it is read. A body past the
// limit answers 413. tacho.host-routes.ts mounts routes by this limit.
const MAX_BODY_BYTES = 16 * 1024;

export const workOrderClaimRoute = new Hono<AppEnv>();

workOrderClaimRoute.use("*", async (c, next) => {
  if (!c.get("apiKeyId")) {
    throw new HTTPException(401, { message: "API key required" });
  }
  await next();
});

workOrderClaimRoute.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new HTTPException(413, { message: "Payload Too Large" });
    },
  }),
);

workOrderClaimRoute.post("/work-orders/claim", async (c) => {
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

  const input = workOrderClaim.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workOrderClaim.name, input, ctx, {
    surface: "api",
  });
  c.header("Cache-Control", "no-store");
  return c.json(output);
});
