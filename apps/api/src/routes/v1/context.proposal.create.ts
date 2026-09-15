import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Open a record proposal. Mounted on the org-scoped router behind session auth (ADR-061). */
export const contextProposalCreateRoute = new Hono<AppEnv>();

contextProposalCreateRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = contextProposalCreate.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextProposalCreate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
