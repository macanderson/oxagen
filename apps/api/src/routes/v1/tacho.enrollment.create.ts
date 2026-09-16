import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { tachoEnrollmentCreate } from "@oxagen/oxagen/contracts/tacho.enrollment.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Enrol a machine as a Tacho host. Operator action: an org Owner or Admin, by session or by the API key `oxagen login` minted for them (the credential the tacho CLI and desktop app carry). A machine-bound key is refused, so an already-enrolled machine cannot mint further enrollments. Mounted on the org-scoped router. */
export const tachoEnrollmentCreateRoute = new Hono<AppEnv>();

tachoEnrollmentCreateRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = tachoEnrollmentCreate.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(tachoEnrollmentCreate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 201);
});
