import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextPrRefresh } from "@oxagen/oxagen/contracts/context.pr.refresh";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read a proposal's Context PR from the host now and move the proposal to the host's state. Mounted on the org-scoped router behind session auth (ADR-184). */
export const contextPrRefreshRoute = new Hono<AppEnv>();

contextPrRefreshRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = contextPrRefresh.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextPrRefresh.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
