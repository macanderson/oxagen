import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolStudioReviewOpen } from "@oxagen/oxagen/contracts/tool.studio.review.open";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Open one steering PR from Studio's draft for a server folder. Mounted on the org-scoped router behind session auth. */
export const toolStudioReviewOpenRoute = new Hono<AppEnv>();

toolStudioReviewOpenRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStudioReviewOpen.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStudioReviewOpen.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
