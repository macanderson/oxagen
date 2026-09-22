import { Hono } from "hono";
import { tachoSessionPolicyRead } from "@oxagen/oxagen/contracts/tacho.session_policy.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const tachoSessionPolicyReadRoute = new Hono<AppEnv>();

tachoSessionPolicyReadRoute.get("/", async (c) => {
  const input = tachoSessionPolicyRead.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(tachoSessionPolicyRead.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
