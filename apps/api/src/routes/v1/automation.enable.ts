import { Hono } from "hono";
import { automationEnable } from "@oxagen/oxagen/contracts/automation.enable";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const automationEnableRoute = new Hono<AppEnv>();

automationEnableRoute.post("/", async (c) => {
  const body = automationEnable.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(automationEnable.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
