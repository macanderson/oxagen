import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { instructionPromote } from "@oxagen/oxagen/contracts/repository.instruction.promote";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Turn one instruction-file statement that contradicts a steering record into
 * a proposal for that record, and open the proposal's steering PR
 * (`promote_instruction_to_steering`, #4518). The body names the finding from
 * `list_code_repository_findings`. Each call opens a new proposal, so it
 * answers 201. Mounted on the org-scoped router.
 */
export const instructionPromoteRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/repository/findings/promote
instructionPromoteRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = instructionPromote.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(instructionPromote.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 201);
});
