import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { tachoEnrollmentTokenCreate } from "@oxagen/oxagen/contracts/tacho.enrollment_token.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Mint a registered agent's single-use enrollment token. Operator action behind session auth on the org-scoped router. */
export const tachoEnrollmentTokenCreateRoute = new Hono<AppEnv>();

tachoEnrollmentTokenCreateRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = tachoEnrollmentTokenCreate.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(tachoEnrollmentTokenCreate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 201);
});
