import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { costUnpricedModelList } from "@oxagen/oxagen/contracts/cost.unpriced_model.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the models this organization runs that the price book cannot price. Mounted on the org-scoped router behind session auth. */
export const costUnpricedModelListRoute = new Hono<AppEnv>();

costUnpricedModelListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = costUnpricedModelList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(costUnpricedModelList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
