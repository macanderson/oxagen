import { z } from "zod";
import { registerCapability } from "../registry";
import { capabilitySummary } from "./capability.registry.list";

/**
 * capability.registry.get — one typed contract as the enforced object.
 *
 * The detail read behind the Capability & Contract catalog's drawer: given a
 * capability name, return the full accountability binding — identity (default
 * role grants + fallback effect), knowledge scope (tenancy + audit target),
 * permitted action (description, mode, surfaces, input/output field specs),
 * commercial terms (billing gate + entitlement pack), and chaining metadata.
 *
 * Field specs are derived from the contract's zod schemas at read time so the
 * catalog never drifts from the enforced shape. Returns `capability: null`
 * (rather than throwing) for an unknown name so surfaces can render a clean
 * not-found state.
 */

const fieldSpec = z.object({
  name: z.string(),
  type: z.string().describe("Human-readable type (e.g. string, number, enum(a|b))"),
  required: z.boolean(),
  description: z.string().nullable(),
});

const capabilityDetail = capabilitySummary.extend({
  inputFields: z
    .array(fieldSpec)
    .describe("Top-level input fields derived from the contract's zod schema"),
  outputFields: z
    .array(fieldSpec)
    .describe("Top-level output fields derived from the contract's zod schema"),
  auditTargetIdField: z
    .string()
    .nullable()
    .describe("Input field carrying the audit target id, when declared"),
  produces: z.array(z.string()).describe("Semantic data tags this capability yields"),
  consumes: z.array(z.string()).describe("Semantic data tags this capability requires"),
  chainHints: z
    .array(z.string())
    .describe("Capability names that commonly run after this one"),
});

export const capabilityRegistryGet = registerCapability({
  name: "get_capability_registry",
  domain: "capability",
  description:
    "Read one typed capability contract from the live registry as the full enforced object — identity grants, tenancy scope, permitted action with input/output field specs, commercial terms (billing gate + entitlement pack), and chaining metadata. Read-only platform metadata.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  // Same reasoning as list_capability_registry: governance introspection must
  // never be blocked by a zero credit balance.
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
    org: { Owner: "allow", Admin: "allow", Compliance: "allow" },
    workspace: { Owner: "allow" },
  },
  // The accountability chain applied to itself: reading a contract records
  // which contract was inspected.
  audit: { targetKind: "capability", targetIdField: "name" },
  input: z.object({
    name: z
      .string()
      .min(1)
      .describe("Capability name to look up (ADR-025 snake_case, e.g. 'query_audit_log')"),
  }),
  output: z.object({
    capability: capabilityDetail
      .nullable()
      .describe("The full contract detail, or null when no capability has that name"),
  }),
});

export type CapabilityRegistryGetInput = z.output<typeof capabilityRegistryGet.input>;
export type CapabilityRegistryGetOutput = z.output<typeof capabilityRegistryGet.output>;
export type CapabilityFieldSpec = z.output<typeof fieldSpec>;
export type CapabilityRegistryDetail = z.output<typeof capabilityDetail>;
