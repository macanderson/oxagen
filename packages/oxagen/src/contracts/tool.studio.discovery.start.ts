import { z } from "zod";
import { registerCapability } from "../registry";
import { studioDiscoverySchema } from "./tool.studio.discovery.get";
import { studioServerNameSchema } from "./tool.studio.draft.save";

/**
 * Ask for one server's tool discovery now (lane M10, #4682). The server is
 * marked queued and one discovery runs in the background, whatever the
 * server's sync.schedule says. A discovery that finds a changed tool list
 * opens or updates the server's sync steering PR. Read its progress with
 * `get_studio_discovery`.
 */
export const toolStudioDiscoveryStart = registerCapability({
  name: "start_studio_discovery",
  domain: "tool",
  description:
    "Ask for one server folder's tool discovery now, whatever its sync schedule says. Returns the queued discovery. A discovery that finds a changed tool list opens or updates the server's sync steering PR.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // Discovery reads the server's tool list and spends no model tokens.
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "governance" },
  sensitivity: "medium",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  audit: { targetKind: "tool_server_folder", targetIdField: "server" },
  input: z
    .object({
      /** The folder name under tools/servers/. */
      server: studioServerNameSchema,
    })
    .strict(),
  output: z.object({ discovery: studioDiscoverySchema }),
});

export type ToolStudioDiscoveryStartInput = z.output<typeof toolStudioDiscoveryStart.input>;
export type ToolStudioDiscoveryStartOutput = z.output<typeof toolStudioDiscoveryStart.output>;
