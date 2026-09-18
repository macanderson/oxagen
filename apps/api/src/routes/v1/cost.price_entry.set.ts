import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { costPriceEntrySet } from "@oxagen/oxagen/contracts/cost.price_entry.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Set this organization's negotiated rate for one model and token class.
 * Mounted on the org-scoped router at the same URL the price book is read
 * from, behind session auth.
 *
 * PUT rather than POST: the write is idempotent on the row key (provider,
 * model, token class, region, effectiveFrom), so repeating the same body
 * repeats the same row.
 */
export const costPriceEntrySetRoute = new Hono<AppEnv>();

costPriceEntrySetRoute.put("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = costPriceEntrySet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(costPriceEntrySet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
