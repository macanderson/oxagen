/**
 * Revoke a relay for servers and APIs in a private network (M12, #4685;
 * mcp-studio-spec, Network paths).
 *
 * The handler sets revoked_at and revoked_by_id on the live mcp.relays row
 * that carries this name in the caller's workspace. The broker refuses the
 * relay's token at its next connect and closes a connected relay within 30
 * seconds. Once the row is revoked, create_relay may reuse the name.
 *
 * Surfaces: the API and MCP. Revoking a token puts no secret in a transcript,
 * so an agent may revoke a relay it suspects is compromised. The app has no
 * relay page yet. That UI gap is recorded in
 * docs/capabilities/tool.relay.revoke.md under Reachability.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { relayNameSchema, relayPublicIdSchema } from "./tool.relay.create";

export const toolRelayRevoke = registerCapability({
  name: "revoke_relay",
  domain: "tool",
  description:
    "Revoke a relay by name in this workspace. The broker refuses the relay's token at its next connect, and a connected relay is closed within 30 seconds.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // Revoking a relay spends no model tokens.
  noBillingGate: true,
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  // The same bar as create_relay and revoke_tacho_enrollment.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  // An in-app agent turn pauses for a person's approval before it cuts off a
  // relay that live calls may depend on.
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  audit: { targetKind: "relay", targetIdField: "name" },
  input: z
    .object({
      /** The name of the live relay to revoke. */
      name: relayNameSchema,
    })
    .strict(),
  output: z
    .object({
      publicId: relayPublicIdSchema,
      name: relayNameSchema,
      revokedAt: z.string(),
    })
    .strict(),
});

export type ToolRelayRevokeInput = z.output<typeof toolRelayRevoke.input>;
export type ToolRelayRevokeOutput = z.output<typeof toolRelayRevoke.output>;
