import { Hono } from "hono";
import { evalDatasetItemAdd } from "@oxagen/oxagen/contracts/eval.dataset_item.add";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const evalDatasetItemAddRoute = new Hono<AppEnv>();

evalDatasetItemAddRoute.post("/", async (c) => {
  const input = evalDatasetItemAdd.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(evalDatasetItemAdd.name, input, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});
