import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { spendUnproductive } from "@oxagen/oxagen/contracts/spend.unproductive";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** The workspace's unproductive spend over a day range, with the figures beside it. Mounted on the org-scoped router behind session auth. */
export const spendUnproductiveRoute = new Hono<AppEnv>();

spendUnproductiveRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = spendUnproductive.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(spendUnproductive.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
