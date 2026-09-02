import { Hono } from "hono";
import { pluginCredentialSetSecret } from "@oxagen/oxagen/contracts/plugin.credential.set_secret";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginCredentialSetSecretRoute = new Hono<AppEnv>();

pluginCredentialSetSecretRoute.post("/", async (c) => {
  const body = pluginCredentialSetSecret.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginCredentialSetSecret.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
