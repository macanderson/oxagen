import { Hono } from "hono";
import { apiKeyRotate } from "@oxagen/oxagen/contracts/api.key.rotate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const apiKeyRotateRoute = new Hono<AppEnv>();

apiKeyRotateRoute.post("/", async (c) => {
  const body = apiKeyRotate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(apiKeyRotate.name, body, ctx, { surface: "api" });
  return c.json(result, 201);
});
