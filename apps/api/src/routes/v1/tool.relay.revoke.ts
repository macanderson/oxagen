import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { toolRelayRevoke } from "@oxagen/oxagen/contracts/tool.relay.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Revoke a relay by name in this workspace (M12, #4685). Operator action: an
 * org Owner or Admin, by session or by the API key `oxagen login` minted for
 * them. A machine-bound key is refused. The broker refuses the relay's token at
 * its next connect and closes a connected relay within 30 seconds. Mounted on
 * the org-scoped router.
 */
export const toolRelayRevokeRoute = new Hono<AppEnv>();

toolRelayRevokeRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolRelayRevoke.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolRelayRevoke.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
