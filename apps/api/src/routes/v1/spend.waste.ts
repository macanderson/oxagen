import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { spendWasteList } from "@oxagen/oxagen/contracts/spend.waste";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List this workspace's wasted spend by cause with the runs that prove it. Mounted on the org-scoped router behind session auth. */
export const spendWasteListRoute = new Hono<AppEnv>();

spendWasteListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = spendWasteList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(spendWasteList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
