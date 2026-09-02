import { Hono } from "hono";
import { orgSettingsRead } from "@oxagen/oxagen/contracts/org.settings.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const orgSettingsReadRoute = new Hono<AppEnv>();

orgSettingsReadRoute.get("/", async (c) => {
  const input = orgSettingsRead.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(orgSettingsRead.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
