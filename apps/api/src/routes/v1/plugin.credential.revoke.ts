import { Hono } from "hono";
import { pluginCredentialRevoke } from "@oxagen/oxagen/contracts/plugin.credential.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginCredentialRevokeRoute = new Hono<AppEnv>();

pluginCredentialRevokeRoute.post("/", async (c) => {
  const body = pluginCredentialRevoke.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(pluginCredentialRevoke.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
