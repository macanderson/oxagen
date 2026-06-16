import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginCatalogGet = registerCapability({
  name: "plugin.catalog.get",
  domain: "plugin",
  description: "Get full detail for one catalog server, including rendered README HTML, packages, and remotes.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit"],
  scoped: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ catalogId: z.string() }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    title: z.string().nullable(),
    description: z.string(),
    version: z.string(),
    repository: z.unknown().nullable(),
    websiteUrl: z.string().nullable(),
    icons: z.array(z.unknown()),
    packages: z.array(z.unknown()),
    remotes: z.array(z.unknown()),
    transportTypes: z.array(z.string()),
    authKind: z.string(),
    categories: z.array(z.string()),
    readmeHtml: z.string().nullable(),
    status: z.string(),
  }),
});
