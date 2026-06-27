import { Hono } from "hono";
import { environmentList } from "@oxagen/oxagen/contracts/environment.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const environmentListRoute = new Hono<AppEnv>();

environmentListRoute.post("/", async (c) => {
  const body = environmentList.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(environmentList.name, body, ctx, { surface: "api" });
  return c.json(out);
});
