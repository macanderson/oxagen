import { Hono } from "hono";
import { modelCapabilityList } from "@oxagen/oxagen/contracts/model.capability.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const modelCapabilityListRoute = new Hono<AppEnv>();

// GET /v1/model/capabilities            → the full provider posture matrix
// GET /v1/model/capabilities?vendor=…   → one vendor's row
// GET /v1/model/capabilities?model=…    → the row governing a gateway model id
modelCapabilityListRoute.get("/", async (c) => {
  const input = modelCapabilityList.input.parse({
    vendor: c.req.query("vendor") ?? undefined,
    model: c.req.query("model") ?? undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(modelCapabilityList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
