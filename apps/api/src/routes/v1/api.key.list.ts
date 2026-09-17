import { Hono } from "hono";
import { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const apiKeyListRoute = new Hono<AppEnv>();

apiKeyListRoute.get("/", async (c) => {
  const input = apiKeyList.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(apiKeyList.name, input, ctx, { surface: "api" });
  return c.json(out);
});
