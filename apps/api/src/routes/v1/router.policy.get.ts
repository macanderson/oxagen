import { Hono } from "hono";
import { routerPolicyGet } from "@oxagen/oxagen/contracts/router.policy.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const routerPolicyGetRoute = new Hono<AppEnv>();

// GET /v1/:org/:workspace/router/policy
routerPolicyGetRoute.get("/", async (c) => {
  const input = routerPolicyGet.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(routerPolicyGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
