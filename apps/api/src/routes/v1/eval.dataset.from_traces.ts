import { Hono } from "hono";
import { evalDatasetFromTraces } from "@oxagen/oxagen/contracts/eval.dataset.from_traces";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const evalDatasetFromTracesRoute = new Hono<AppEnv>();

evalDatasetFromTracesRoute.post("/", async (c) => {
  const input = evalDatasetFromTraces.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(evalDatasetFromTraces.name, input, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});
