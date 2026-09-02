import { Hono } from "hono";
import { automationDisable } from "@oxagen/oxagen/contracts/automation.disable";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const automationDisableRoute = new Hono<AppEnv>();

automationDisableRoute.post("/", async (c) => {
  const body = automationDisable.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(automationDisable.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
