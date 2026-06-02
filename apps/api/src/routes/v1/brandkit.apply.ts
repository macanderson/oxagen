import { Hono } from "hono";
import { brandkitApply } from "@oxagen/oxagen/contracts/brandkit.apply";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const brandkitApplyRoute = new Hono<AppEnv>();

// Stub brand-kit application: parses workspaceId/brandKitId/targetFileId input,
// logs intent, and returns a typed placeholder. Route is org + workspace scoped
// (see app.ts).
brandkitApplyRoute.post("/", async (c) => {
  const body = brandkitApply.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(brandkitApply.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
