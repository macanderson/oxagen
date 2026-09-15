import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { iamRoleDelete } from "@oxagen/oxagen/contracts/iam.role.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Delete a custom IAM role nobody holds (ADR-063). Mounted on the org-scoped router behind session auth. */
export const iamRoleDeleteRoute = new Hono<AppEnv>();

iamRoleDeleteRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = iamRoleDelete.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(iamRoleDelete.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
