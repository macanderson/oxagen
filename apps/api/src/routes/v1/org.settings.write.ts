import { Hono } from "hono";
import { orgSettingsWrite } from "@oxagen/oxagen/contracts/org.settings.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const orgSettingsWriteRoute = new Hono<AppEnv>();

orgSettingsWriteRoute.patch("/", async (c) => {
  const body = orgSettingsWrite.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(orgSettingsWrite.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
