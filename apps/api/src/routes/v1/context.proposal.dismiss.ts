import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextProposalDismiss } from "@oxagen/oxagen/contracts/context.proposal.dismiss";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Reject a record proposal with a reason. Mounted on the org-scoped router behind session auth (ADR-061). */
export const contextProposalDismissRoute = new Hono<AppEnv>();

contextProposalDismissRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = contextProposalDismiss.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextProposalDismiss.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
