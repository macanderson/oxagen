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
 * `POST /set`, not `PUT`. The write is idempotent on its row key, but the key
 * includes `effectiveFrom` and the field is optional: a body that omits it
 * takes the write instant, so a client or proxy that retries after a lost
 * response does not repeat the first write — it closes the row that write
 * created and opens another window, with a second audit event. That is not
 * what `PUT` promises, and a proxy is entitled to retry a `PUT` on its own.
 * A caller that wants a safe retry states `effectiveFrom` once and reuses it.
 * Mounted beside `POST /remove`, since `POST /` on this path is the list read.
 */
export const costPriceEntrySetRoute = new Hono<AppEnv>();

costPriceEntrySetRoute.post("/", async (c) => {
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
