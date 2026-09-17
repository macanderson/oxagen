import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runFrameBodyGet } from "@oxagen/oxagen/contracts/run.frame_body.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read one frame's redacted body by its sequence. Mounted on the org-scoped router behind session auth. */
export const runFrameBodyGetRoute = new Hono<AppEnv>();

runFrameBodyGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runFrameBodyGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runFrameBodyGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
