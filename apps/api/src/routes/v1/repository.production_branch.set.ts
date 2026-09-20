import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { repositoryProductionBranchSet } from "@oxagen/oxagen/contracts/repository.production_branch.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Confirm or change a repository's production branch (`set_production_branch`). Mounted on the org-scoped router; the role is checked in the handler. */
export const repositoryProductionBranchSetRoute = new Hono<AppEnv>();

repositoryProductionBranchSetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = repositoryProductionBranchSet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(repositoryProductionBranchSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
