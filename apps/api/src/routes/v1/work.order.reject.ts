import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { workOrderReject } from "@oxagen/oxagen/contracts/work.order.reject";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Refuse a work order the calling enrolled host cannot start, with the
 * reason (`reject_work_order`, ADR-250).
 *
 * Machine-to-machine: the host's API key carries its org and workspace, so
 * this route lives on the static /v1/tacho router and refuses anything but an
 * API key before it reads the body.
 */
// A rejection names one enrollment, one work order, and a reason of at most
// 512 characters, under 2 KiB. 16 KiB leaves room and refuses a large body
// before it is read. A body past the limit answers 413. tacho.host-routes.ts
// mounts routes by this limit.
const MAX_BODY_BYTES = 16 * 1024;

export const workOrderRejectRoute = new Hono<AppEnv>();

workOrderRejectRoute.use("*", async (c, next) => {
  if (!c.get("apiKeyId")) {
    throw new HTTPException(401, { message: "API key required" });
  }
  await next();
});

workOrderRejectRoute.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new HTTPException(413, { message: "Payload Too Large" });
    },
  }),
);

workOrderRejectRoute.post("/work-orders/reject", async (c) => {
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

  const input = workOrderReject.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workOrderReject.name, input, ctx, {
    surface: "api",
  });
  c.header("Cache-Control", "no-store");
  return c.json(output);
});
