import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { costPriceEntryRemove } from "@oxagen/oxagen/contracts/cost.price_entry.remove";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * End this organization's negotiated rate for one model and token class.
 * Mounted on the org-scoped router beside the price-book read, behind session
 * auth.
 *
 * POST to `/remove` rather than DELETE on the collection: nothing is deleted
 * — the row is closed at an instant and kept, because a cost record priced
 * before it still names the entry — and the key plus that instant travel in a
 * body, which DELETE carries unreliably across clients and proxies.
 */
export const costPriceEntryRemoveRoute = new Hono<AppEnv>();

costPriceEntryRemoveRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = costPriceEntryRemove.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(costPriceEntryRemove.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
