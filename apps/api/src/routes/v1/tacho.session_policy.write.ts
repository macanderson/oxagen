import { Hono } from "hono";
import { tachoSessionPolicyWrite } from "@oxagen/oxagen/contracts/tacho.session_policy.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const tachoSessionPolicyWriteRoute = new Hono<AppEnv>();

tachoSessionPolicyWriteRoute.patch("/", async (c) => {
  const body = tachoSessionPolicyWrite.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(tachoSessionPolicyWrite.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
