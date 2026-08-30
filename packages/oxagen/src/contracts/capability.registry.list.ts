import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * capability.registry.list — the typed-contract registry made runtime-readable.
 *
 * Every capability in the platform is one enforced object binding identity →
 * knowledge scope → permitted action → commercial terms → verified outcome →
 * audit record. Until now that registry was introspectable only via CLI
 * (`pnpm check:manifest`). This read-only capability exposes the in-process
 * contract registry (the same source the manifest gate reads) so the org
 * Governance surfaces — the hub's "active contracts" tile and the Capability &
 * Contract catalog — can render the accountability chain from live data.
 *
 * Returns platform metadata only (contract descriptors), never tenant data, so
 * it is `noBillingGate` and low-sensitivity; access still defaults to deny and
 * is granted to org admins + compliance.
 */

const grantEffect = z.enum(["allow", "deny", "require_approval"]);

const capabilitySummary = z.object({
  name: z.string().describe("Capability name (ADR-025 verb-first snake_case)"),
  domain: z.string().describe("Capability domain (e.g. billing, agent, iam)"),
  description: z.string(),
  mode: z.enum(["sync", "async", "batch"]),
  surfaces: z
    .array(z.enum(["api", "mcp", "agent", "cli"]))
    .describe("Surfaces the capability is exposed on"),
  layers: z
    .array(z.enum(["schema", "api", "mcp", "unit", "e2e", "docs", "app"]))
    .describe("Layers the contract declares (parity promises)"),
  sensitivity: z.enum(["low", "medium", "high", "destructive"]),
  defaultEffect: grantEffect.describe(
    "IAM rule-8 fallback when no explicit grant matches",
  ),
  scoped: z.boolean().describe("Whether invocations are tenant-scope enforced"),
  noBillingGate: z
    .boolean()
    .describe(
      "True when the billing admission gate is skipped (management reads)",
    ),
  agent: z
    .object({
      requiresApproval: z.boolean(),
      riskLevel: z.enum(["low", "medium", "high"]),
      category: z.string().nullable(),
    })
    .nullable()
    .describe("Agent-surface metadata, when the agent surface is declared"),
  auditTargetKind: z
    .string()
    .nullable()
    .describe(
      "Declared audit-target kind (accountability-chain target extraction)",
    ),
  plugin: z
    .object({
      id: z
        .string()
        .describe("Capability-pack plugin id (e.g. oxagen/media-svg)"),
      tier: z.enum(["free", "premium"]),
      minPlanTier: z.enum(["free", "build", "scale", "enterprise"]).nullable(),
    })
    .nullable()
    .describe(
      "Entitlement gate: the plugin pack that must be installed, if any",
    ),
  orgRoles: z
    .record(grantEffect)
    .describe("Default org-role grants (role name → effect)"),
  workspaceRoles: z
    .record(grantEffect)
    .describe("Default workspace-role grants (role name → effect)"),
});

export const capabilityRegistryList = registerCapability({
  name: "list_capability_registry",
  domain: "capability",
  description:
    "List the platform's typed capability contracts from the live in-process registry — name, domain, surfaces, layers, sensitivity, default IAM grants, entitlement gate, and audit binding for each. Read-only platform metadata; powers the org governance catalog.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  // Reading contract metadata must never consume credits or be blocked by a
  // zero balance — it is how an org inspects its own governance posture.
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Compliance: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    domain: z
      .string()
      .optional()
      .describe("Exact domain filter (e.g. 'billing')"),
    q: z
      .string()
      .optional()
      .describe(
        "Case-insensitive substring match on name, domain, or description",
      ),
    surface: z
      .enum(["api", "mcp", "agent", "cli"])
      .optional()
      .describe("Only capabilities exposed on this surface"),
    missingLayer: z
      .enum(["schema", "api", "mcp", "unit", "e2e", "docs", "app"])
      .optional()
      .describe(
        "Only capabilities that do NOT declare this layer (surface-gap filter)",
      ),
    sensitivity: z
      .enum(["low", "medium", "high", "destructive"])
      .optional()
      .describe("Only capabilities with this sensitivity classification"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(500)
      .describe("Max rows to return"),
    offset: z.number().int().min(0).default(0).describe("Pagination offset"),
  }),
  output: z.object({
    capabilities: z
      .array(capabilitySummary)
      .describe("Matching contracts, sorted by name"),
    total: z.number().int().describe("Total matches before pagination"),
    hasMore: z.boolean(),
    limit: z.number().int(),
    offset: z.number().int(),
    domains: z
      .array(z.string())
      .describe("All distinct domains in the registry (unfiltered), sorted"),
  }),
});

export type CapabilityRegistryListInput = z.output<
  typeof capabilityRegistryList.input
>;
export type CapabilityRegistryListOutput = z.output<
  typeof capabilityRegistryList.output
>;
export type CapabilityRegistrySummary = z.output<typeof capabilitySummary>;

// Shared with capability.registry.get (the detail view extends the summary).
export { capabilitySummary };
