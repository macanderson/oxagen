import { z } from "zod";
import { registerCapability } from "../registry";
import {
  consequenceTagSchema,
  toolClassificationSchema,
  toolRiskGradeSchema,
} from "./tool.classification";

/** Which active kill switch stops a version today, in the recorded decision order (INV-10). */
export const toolGateSchema = z.object({
  /** `open` when no switch reaches the version. */
  kind: z.enum(["open", "killed_version", "killed_server", "killed_class"]),
  /** The switch's `emd_…` id when killed; null when open. */
  switchId: z.string().nullable(),
});

export const toolVersionItemSchema = z.object({
  /** `tlv_…` */
  id: z.string(),
  /** `tol_…` */
  toolId: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  version: z.number().int().positive(),
  source: z.enum(["builtin", "custom", "mcp", "foundry"]),
  /** The `mcs_…` server an imported tool came from; null for a declared tool. */
  serverId: z.string().nullable(),
  /** The capability id a call to this version is governed under (`mcp.<server>.<tool>` for an imported tool). */
  capabilityId: z.string(),
  readOnly: z.boolean(),
  /** The grade set with the classification, or the declared grade while the version is unclassified. */
  riskGrade: toolRiskGradeSchema,
  /** Null until an admin classifies the tool; a new version starts with the classification of the one it replaces. */
  classification: toolClassificationSchema.nullable(),
  classifiedAt: z.string().nullable(),
  schemaOrigin: z.enum(["declared", "imported"]),
  /** SHA-256 hex over the canonical manifest. */
  schemaDigest: z.string(),
  enabled: z.boolean(),
  gate: toolGateSchema,
  /** Calls in the last 30 days from ClickHouse `tool_invocations`; null when the store did not answer. */
  calls30d: z.number().int().nonnegative().nullable(),
  updatedAt: z.string(),
});

export const toolVersionList = registerCapability({
  name: "list_tool_versions",
  domain: "tool",
  description:
    "List the workspace registry's active tool versions with their safety classification, schema origin and digest, the kill switch that stops each one today, and 30-day call counts; cursor-paged, optionally filtered by consequence tag, by the server the tools were imported from, or both.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  // A console read: listing the registry is never a governed action
  // (ADR-052 exclusion 2, INV-28).
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    /** Only versions carrying this consequence tag. */
    category: consequenceTagSchema.optional(),
    /** Only versions imported from this `mcs_…` server. */
    serverId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    /** The `nextCursor` of an earlier page. */
    cursor: z.string().min(1).optional(),
  }),
  output: z.object({
    items: z.array(toolVersionItemSchema),
    nextCursor: z.string().nullable(),
  }),
});

export type ToolVersionListInput = z.output<typeof toolVersionList.input>;
export type ToolVersionListOutput = z.output<typeof toolVersionList.output>;
export type ToolVersionItem = z.output<typeof toolVersionItemSchema>;
export type ToolGate = z.output<typeof toolGateSchema>;
