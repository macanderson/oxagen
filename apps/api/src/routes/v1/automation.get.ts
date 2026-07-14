import { Hono } from "hono";
import { automationGet } from "@oxagen/oxagen/contracts/automation.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const automationGetRoute = new Hono<AppEnv>();

automationGetRoute.get("/", async (c) => {
  const automation_id = c.req.query("automation_id");
  const input = automationGet.input.parse({ automation_id });
  const ctx = capabilityContext(c);
  const out = await invoke(automationGet.name, input, ctx, { surface: "api" });
  return c.json(out);
});
