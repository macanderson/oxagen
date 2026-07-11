import { Hono } from "hono";
import { routerDecisionPreview } from "@oxagen/oxagen/contracts/router.decision.preview";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const routerDecisionPreviewRoute = new Hono<AppEnv>();

// POST /v1/:org/:workspace/router/preview
routerDecisionPreviewRoute.post("/", async (c) => {
  const body: unknown = await c.req.json().catch(() => ({}));
  const input = routerDecisionPreview.input.parse(body);
  const ctx = capabilityContext(c);
  const out = await invoke(routerDecisionPreview.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
