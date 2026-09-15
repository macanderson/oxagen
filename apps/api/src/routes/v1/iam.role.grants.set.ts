import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { iamRoleGrantsSet } from "@oxagen/oxagen/contracts/iam.role.grants.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Replace a custom IAM role's grants with a permission set (ADR-063). Mounted on the org-scoped router behind session auth. */
export const iamRoleGrantsSetRoute = new Hono<AppEnv>();

iamRoleGrantsSetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = iamRoleGrantsSet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(iamRoleGrantsSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
