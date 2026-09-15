import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentRegister } from "@oxagen/oxagen/contracts/agent.register";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Register an agent identity: principal, default role and a credential shown once. The handler checks the org role. Mounted on the org-scoped router behind session auth. */
export const agentRegisterRoute = new Hono<AppEnv>();

agentRegisterRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = agentRegister.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(agentRegister.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
