import { Hono } from "hono";
import { promptSettingsWrite } from "@oxagen/oxagen/contracts/prompt.settings.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const promptSettingsWriteRoute = new Hono<AppEnv>();

promptSettingsWriteRoute.patch("/", async (c) => {
  const body = promptSettingsWrite.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(promptSettingsWrite.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
