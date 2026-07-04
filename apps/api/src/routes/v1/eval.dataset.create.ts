import { Hono } from "hono";
import { evalDatasetCreate } from "@oxagen/oxagen/contracts/eval.dataset.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const evalDatasetCreateRoute = new Hono<AppEnv>();

evalDatasetCreateRoute.post("/", async (c) => {
  const input = evalDatasetCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(evalDatasetCreate.name, input, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});
