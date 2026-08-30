import { Hono } from "hono";
import { automationUpdate } from "@oxagen/oxagen/contracts/automation.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const automationUpdateRoute = new Hono<AppEnv>();

automationUpdateRoute.patch("/", async (c) => {
  const body = automationUpdate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(automationUpdate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
