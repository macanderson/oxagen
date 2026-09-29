import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolRelayCreate } from "@oxagen/oxagen/contracts/tool.relay.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Register a relay for a private network and mint its relay token (M12, #4685).
 * Operator action: an org Owner or Admin, by session or by the API key
 * `oxagen login` minted for them. A machine-bound key is refused. The response
 * carries the plaintext token once, and Oxagen cannot show it again. The API is
 * this capability's only surface, so the token never enters an agent's
 * transcript. Mounted on the org-scoped router.
 */
export const toolRelayCreateRoute = new Hono<AppEnv>();

toolRelayCreateRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolRelayCreate.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolRelayCreate.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 201);
});
