import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { costPriceEntryList } from "@oxagen/oxagen/contracts/cost.price_entry.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the price book this organization is priced against. Mounted on the org-scoped router behind session auth. */
export const costPriceEntryListRoute = new Hono<AppEnv>();

costPriceEntryListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = costPriceEntryList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(costPriceEntryList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
