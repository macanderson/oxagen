import { Hono } from "hono";
import { promptSettingsRead } from "@oxagen/oxagen/contracts/prompt.settings.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const promptSettingsReadRoute = new Hono<AppEnv>();

promptSettingsReadRoute.get("/", async (c) => {
  const input = promptSettingsRead.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(promptSettingsRead.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
