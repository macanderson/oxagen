import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringProposalCreate } from "@oxagen/oxagen/contracts/steering.proposal.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Open a record proposal. Mounted on the org-scoped router behind session auth (ADR-061). */
export const steeringProposalCreateRoute = new Hono<AppEnv>();

steeringProposalCreateRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = steeringProposalCreate.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringProposalCreate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
