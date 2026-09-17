import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the workspace's record proposals with their Context PR state. Mounted on the org-scoped router behind session auth (ADR-061). */
export const contextProposalListRoute = new Hono<AppEnv>();

contextProposalListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = contextProposalList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(contextProposalList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
