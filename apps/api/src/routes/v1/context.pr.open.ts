import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextPrOpen } from "@oxagen/oxagen/contracts/context.pr.open";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Open a proposal's Context PR and run its checks. Mounted on the org-scoped router behind session auth (ADR-061). */
export const contextPrOpenRoute = new Hono<AppEnv>();

contextPrOpenRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = contextPrOpen.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextPrOpen.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
