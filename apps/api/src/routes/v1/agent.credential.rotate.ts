import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentCredentialRotate } from "@oxagen/oxagen/contracts/agent.credential.rotate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Rotate an agent's long-lived credential. The handler checks the org role. Mounted on the org-scoped router behind session auth. */
export const agentCredentialRotateRoute = new Hono<AppEnv>();

agentCredentialRotateRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = agentCredentialRotate.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(agentCredentialRotate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
