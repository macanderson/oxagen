import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { tachoEnrollmentRevoke } from "@oxagen/oxagen/contracts/tacho.enrollment.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Revoke a Tacho host enrollment. Mounted on the org-scoped router behind session auth. */
export const tachoEnrollmentRevokeRoute = new Hono<AppEnv>();

tachoEnrollmentRevokeRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = tachoEnrollmentRevoke.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(tachoEnrollmentRevoke.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
