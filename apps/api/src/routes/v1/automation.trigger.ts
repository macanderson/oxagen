import { Hono } from "hono";
import { automationTrigger } from "@oxagen/oxagen/contracts/automation.trigger";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const automationTriggerRoute = new Hono<AppEnv>();

automationTriggerRoute.post("/", async (c) => {
  const body = automationTrigger.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(automationTrigger.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
