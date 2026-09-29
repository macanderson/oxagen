/**
 * Register a relay for servers and APIs in a private network (M12, #4685;
 * mcp-studio-spec, Network paths).
 *
 * A relay runs inside your network and connects out to Oxagen's broker. It
 * authenticates with the relay token this capability mints. Oxagen stores only
 * the token's SHA-256 in mcp.relays, so the plaintext token in the output is
 * shown once and cannot be read again. A call routes to the relay when its
 * network is `relay:<name>`.
 *
 * Surfaces: the API only. An MCP tool would put the plaintext token in the
 * agent's transcript, so no agent may mint one. The app has no relay page yet.
 * That UI gap is recorded in docs/capabilities/tool.relay.create.md under
 * Reachability.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * A relay's name. It must equal RELAY_NAME_PATTERN in @oxagen/mcp-studio and
 * the name part of the broker's relay:<name> network pattern. This package
 * cannot import either one, so
 * packages/handlers/src/mcp-studio/relays/name-pattern.test.ts holds all
 * three equal.
 */
export const RELAY_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const relayNameSchema = z
  .string()
  .regex(
    RELAY_NAME_REGEX,
    "A relay name is a lowercase letter or digit, then up to 62 lowercase letters, digits, or hyphens.",
  );

/** The public id of a relay: rly_ and 22 lowercase Crockford base32 characters. */
export const relayPublicIdSchema = z.string().regex(/^rly_[0-9a-z]{22}$/);

export const toolRelayCreate = registerCapability({
  name: "create_relay",
  domain: "tool",
  description:
    "Register a relay for servers and APIs in a private network, and mint its relay token. The token is shown once in this response and cannot be read again. Oxagen stores only its SHA-256.",
  mode: "sync",
  // Operator action: an MCP tool would put the plaintext token in the agent's
  // transcript, so the API is the only surface.
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  // Registering a relay spends no model tokens.
  noBillingGate: true,
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  // The same bar as create_tacho_enrollment: a relay token lets a process
  // inside your network carry the workspace's calls.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  audit: { targetKind: "relay", targetIdField: "name" },
  input: z
    .object({
      /** The name a call's network = relay:<name> routes by. */
      name: relayNameSchema,
    })
    .strict(),
  output: z
    .object({
      publicId: relayPublicIdSchema,
      name: relayNameSchema,
      createdAt: z.string(),
      /** Shown once. Never recoverable. */
      token: z.string().startsWith("oxr_"),
    })
    .strict(),
});

export type ToolRelayCreateInput = z.output<typeof toolRelayCreate.input>;
export type ToolRelayCreateOutput = z.output<typeof toolRelayCreate.output>;
