import { z } from "zod";

// ── Capability Pack Manifest Schema ───────────────────────────────────────────
//
// Pure data — no side effects. Zod schema is DB-mirrorable by design: Phase 3
// syncs partner manifests into a `plugin.capability_catalog` Postgres table
// using this same schema as the validation layer.
//
// First-party manifests live in `catalog/` subdirectories as static objects;
// the registry validates them at startup.

/** Slugified plugin identifier, e.g. "oxagen/media-video". */
const pluginIdSchema = z
  .string()
  .regex(
    /^[a-z0-9-]+\/[a-z0-9-]+$/,
    'Plugin id must be of the form "<namespace>/<slug>" using lowercase letters, digits, and hyphens.',
  );

/** The five plugin taxonomy types mirroring the DB CHECK constraint. */
export const PLUGIN_TYPE_VALUES = [
  "agent_skill",
  "agent_capability",
  "mcp_server",
  "knowledge_source",
  "integration",
] as const;

export type PluginManifestType = (typeof PLUGIN_TYPE_VALUES)[number];

export const oxagenPluginManifestSchema = z.object({
  /** Stable, unique plugin identifier. Format: `<namespace>/<slug>`. */
  id: pluginIdSchema,

  /** Human-readable display name, e.g. "Video Generation". */
  name: z.string().min(1),

  /** One-sentence summary shown in the marketplace listing. */
  description: z.string().min(1),

  /**
   * Semver version string. First-party capability packs always ship as the
   * latest in-repo version; the field is recorded for the DB mirror in Phase 3.
   */
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver (e.g. 1.0.0)"),

  /**
   * The five-type plugin taxonomy. Determines which marketplace tab the pack
   * appears under and how it is installed/enabled.
   *
   * - `agent_capability` — first-party capability packs (media-*, documents).
   *   Uninstalled by default; requires explicit install + enable.
   * - `agent_skill`      — workspace skills seeded from `agent.skills`.
   *   Installed-by-default; sourced live from DB, no manifest mirror needed.
   * - `mcp_server`       — MCP servers fetched live from registries.
   * - `knowledge_source` — knowledge connectors.
   * - `integration`      — third-party service integrations.
   */
  pluginType: z.enum(PLUGIN_TYPE_VALUES),

  /**
   * Whether the pack requires a paid plan. Enforced in Phase 2; recorded
   * now so the schema is stable.
   */
  tier: z.enum(["free", "premium"]),

  /**
   * Marketplace visibility. "hidden" and "preview" packs are excluded from
   * the public browse response; "beta" and "ga" are shown.
   */
  visibility: z.enum(["hidden", "preview", "beta", "ga"]),

  /** Marketplace tab grouping (e.g. "media", "documents"). */
  category: z.string().min(1),

  /** Lucide icon name for the marketplace card. Optional. */
  icon: z.string().optional(),

  /**
   * The capability contract names claimed by this plugin. At least one is
   * required — zero-contract plugins are not valid capability packs. The
   * registry additionally validates that no contract is claimed by more than
   * one plugin.
   */
  contracts: z.array(z.string().min(1)).min(1, "A plugin must claim at least one contract."),

  /**
   * Minimum billing plan tier required to install. Recorded now; enforced
   * in Phase 2. Absent means "any plan".
   */
  minPlanTier: z.enum(["free", "build", "scale", "enterprise"]).optional(),

  /**
   * Reserved for Phase 3 partner protocol (context envelope + scoped graph
   * tokens). First-party plugins always have an empty array.
   */
  scopes: z.array(z.string()),
});

export type OxagenPluginManifest = z.infer<typeof oxagenPluginManifestSchema>;
