import { Hono } from "hono";
import { apiKeyCreate } from "@oxagen/oxagen/contracts/api.key.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const apiKeyCreateRoute = new Hono<AppEnv>();

apiKeyCreateRoute.post("/", async (c) => {
  const body = apiKeyCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(apiKeyCreate.name, body, ctx, { surface: "api" });
  return c.json(result, 201);
});
