import { z } from "zod";
import { registerCapability } from "../registry";

// Single version entry in the version history
const pluginVersionEntrySchema = z.object({
  version: z.string().describe("SemVer version string (e.g. '1.3.0')"),
  releasedAt: z.string().describe("ISO 8601 release timestamp"),
  isBreaking: z
    .boolean()
    .describe("True when this version contains breaking config schema changes"),
  breakingChanges: z
    .array(z.string())
    .optional()
    .describe(
      "Descriptions of breaking changes (only present when isBreaking is true)",
    ),
  changelog: z
    .string()
    .optional()
    .describe("Markdown-formatted changelog for this version"),
  schemaVersion: z
    .string()
    .describe(
      "Schema format version (apiVersion tag) used by this plugin version",
    ),
  minimumPlatformVersion: z
    .string()
    .optional()
    .describe(
      "Minimum Oxagen platform version required for this plugin version",
    ),
});

export const pluginVersionList = registerCapability({
  name: "list_plugin_versions",
  domain: "plugin",
  description:
    "List version history for a connector plugin including changelog entries and breaking-change flags. Used by org admins to review update impact before upgrading.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "plugin" },
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    pluginId: z
      .string()
      .describe("Connector plugin identifier (e.g. 'github', 'google-drive')"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Maximum number of versions to return, newest first"),
    includeChangelog: z
      .boolean()
      .default(false)
      .describe(
        "When true, include full markdown changelog per version. False returns summary only.",
      ),
  }),
  output: z.object({
    pluginId: z.string(),
    currentVersion: z
      .string()
      .describe("Latest available version of this plugin"),
    installedVersion: z
      .string()
      .nullable()
      .describe(
        "Version currently installed for this org, or null if not installed",
      ),
    hasBreakingUpdate: z
      .boolean()
      .describe(
        "True when any version between installedVersion and currentVersion is breaking",
      ),
    versions: z.array(pluginVersionEntrySchema),
  }),
});
