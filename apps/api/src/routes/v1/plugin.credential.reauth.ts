import { Hono } from "hono";
import { pluginCredentialReauth } from "@oxagen/oxagen/contracts/plugin.credential.reauth";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginCredentialReauthRoute = new Hono<AppEnv>();

pluginCredentialReauthRoute.post("/", async (c) => {
  const body = pluginCredentialReauth.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginCredentialReauth.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
