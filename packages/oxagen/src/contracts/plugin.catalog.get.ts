import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginCatalogGet = registerCapability({
  name: "get_catalog_plugin",
  domain: "plugin",
  description:
    "Get full detail for one catalog server by name+version, fetched live from the workspace's enabled registries.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit"],
  scoped: true,
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    /** Registry server name (e.g. "@anthropic-ai/model-context-protocol-servers-brave-search"). */
    name: z.string(),
    /** Semver version string, or "latest" to resolve the latest published version. */
    version: z.string().default("latest"),
  }),
  output: z.object({
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
    /** Sanitized README HTML (rehype-sanitize'd), when a GitHub repository is resolvable. */
    readmeHtml: z.string().nullable().optional(),
  }),
});
