import { Hono } from "hono";
import { routerPolicySet } from "@oxagen/oxagen/contracts/router.policy.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const routerPolicySetRoute = new Hono<AppEnv>();

// POST /v1/:org/:workspace/router/policy
routerPolicySetRoute.post("/", async (c) => {
  const input = routerPolicySet.input.parse(
    await c.req.json().catch(() => ({})),
  );
  const ctx = capabilityContext(c);
  const out = await invoke(routerPolicySet.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
