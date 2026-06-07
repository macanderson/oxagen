import { Hono } from "hono";
import { apiKeyRevoke } from "@oxagen/oxagen/contracts/api.key.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const apiKeyRevokeRoute = new Hono<AppEnv>();

apiKeyRevokeRoute.delete("/", async (c) => {
  const body = apiKeyRevoke.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(apiKeyRevoke.name, body, ctx, { surface: "api" });
  return c.json(result, 200);
});
