import { z } from "zod";
import { registerCapability } from "../registry";

const pluginTypeEnum = z.enum([
  "mcp_server",
  "integration",
  "agent_skill",
  "agent_capability",
  "knowledge_source",
]);

export const pluginOrgInstall = registerCapability({
  name: "install_plugin",
  domain: "plugin",
  description: "Install a plugin into this workspace.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: true, riskLevel: "medium", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    pluginType: pluginTypeEnum.default("mcp_server"),
    // Required when pluginType === "agent_capability"; validated in the handler.
    pluginId: z.string().optional(),
    custom: z
      .object({
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        endpointUrl: z.string(),
        transport: z.string(),
        authKind: z.enum(["oauth", "secret", "none"]),
      })
      .optional(),
  }),
  output: z.object({
    orgListingId: z.string(),
  }),
});
