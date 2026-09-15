import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { iamRoleCreate } from "@oxagen/oxagen/contracts/iam.role.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Create a custom IAM role from the permission catalogue (ADR-063). Mounted on the org-scoped router behind session auth. */
export const iamRoleCreateRoute = new Hono<AppEnv>();

iamRoleCreateRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = iamRoleCreate.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(iamRoleCreate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 201);
});
