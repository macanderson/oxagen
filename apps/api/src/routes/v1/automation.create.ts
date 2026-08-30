import { Hono } from "hono";
import { automationCreate } from "@oxagen/oxagen/contracts/automation.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const automationCreateRoute = new Hono<AppEnv>();

automationCreateRoute.post("/", async (c) => {
  const body = automationCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(automationCreate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
