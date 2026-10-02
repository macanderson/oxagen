import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringProposalList } from "@oxagen/oxagen/contracts/steering.proposal.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the workspace's record proposals with their steering PR state. Mounted on the org-scoped router behind session auth (ADR-061). */
export const steeringProposalListRoute = new Hono<AppEnv>();

steeringProposalListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = steeringProposalList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringProposalList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
