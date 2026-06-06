import { z } from "zod";
import { registerCapability } from "../registry";

const pluginTypeEnum = z.enum(["mcp_server", "integration", "content_tool"]);

export const pluginOrgInstall = registerCapability({
  name: "plugin.org.install",
  domain: "plugin",
  description: "Install a catalog or custom plugin server to the org allow-list (disabled by default).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    pluginType: pluginTypeEnum.default("mcp_server"),
    catalogServerId: z.string().optional(),
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
