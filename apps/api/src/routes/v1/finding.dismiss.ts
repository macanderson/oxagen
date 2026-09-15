import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { findingDismiss } from "@oxagen/oxagen/contracts/finding.dismiss";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Dismiss an open finding without applying its fix (org Owner or Admin; checked in the handler). Mounted on the org-scoped router behind session auth. */
export const findingDismissRoute = new Hono<AppEnv>();

findingDismissRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = findingDismiss.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(findingDismiss.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
