import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextPrDiffGet } from "@oxagen/oxagen/contracts/context.pr.diff.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Get the files a proposal's Context PR changes, read from the host now. Mounted on the org-scoped router behind session auth (ADR-184). */
export const contextPrDiffGetRoute = new Hono<AppEnv>();

contextPrDiffGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = contextPrDiffGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextPrDiffGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
