import { Hono } from "hono";
import { evalDatasetList } from "@oxagen/oxagen/contracts/eval.dataset.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const evalDatasetListRoute = new Hono<AppEnv>();

evalDatasetListRoute.get("/", async (c) => {
  const input = evalDatasetList.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(evalDatasetList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
