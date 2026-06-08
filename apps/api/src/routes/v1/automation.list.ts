import { Hono } from "hono";
import { automationList } from "@oxagen/oxagen/contracts/automation.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const automationListRoute = new Hono<AppEnv>();

automationListRoute.get("/", async (c) => {
  const workspace_id = c.req.query("workspace_id");
  const input = automationList.input.parse({ workspace_id });
  const ctx = capabilityContext(c);
  const out = await invoke(automationList.name, input, ctx, { surface: "api" });
  return c.json(out);
});
