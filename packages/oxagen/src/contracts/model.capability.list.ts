import { z } from "zod";
import { registerCapability } from "../registry";

// Introspect the provider capability posture registry (@oxagen/ai
// provider-posture) — the typed per-vendor feature matrix declaring, for every
// vendor the gateway can route to, how its prompt cache is engaged, how its
// reasoning budget is controlled, how schema-constrained output is obtained,
// and which attachment kinds it accepts.
//
// Why this is a capability and not just an internal module: Oxagen is BYOK and
// vendor-neutral, so a reseller routing work to a customer-configured provider
// needs to know what that provider ACTUALLY supports before dispatching — most
// importantly whether its cache is explicit opt-in (Anthropic) or implicit
// (OpenAI/Gemini/DeepSeek), because getting that wrong bills every token at the
// full input rate silently. Exposing the matrix over api/mcp/cli turns that
// knowledge from adapter folklore into something a caller can query.
//
// The underlying data is a static, compile-time-complete registry, so this is
// unscoped (`scoped: false`) and read-only — it describes the platform's
// provider surface, not any tenant's rows.

const cachePostureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("opt-in"),
    mechanism: z
      .string()
      .describe(
        "The wire mechanism that must be SENT or the provider caches nothing",
      ),
    witness: z
      .string()
      .describe(
        "Title of the test proving the opt-in marker reaches the request",
      ),
  }),
  z.object({
    kind: z.literal("implicit"),
    telemetry: z
      .string()
      .describe("Where the provider reports cache hits on its usage envelope"),
    witness: z
      .string()
      .describe(
        "Title of the test proving the hit telemetry is parsed and metered",
      ),
  }),
  z.object({
    kind: z.literal("not-applicable"),
    reason: z.string(),
  }),
]);

const reasoningPostureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("controllable"),
    mechanism: z.string(),
    witness: z.string(),
  }),
  z.object({ kind: z.literal("fixed-on"), note: z.string() }),
  z.object({ kind: z.literal("fixed-off"), note: z.string() }),
  z.object({ kind: z.literal("unsupported"), note: z.string() }),
  z.object({ kind: z.literal("not-applicable"), reason: z.string() }),
]);

const structuredOutputPostureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("native"),
    mechanism: z.string(),
    witness: z.string(),
  }),
  z.object({
    kind: z.literal("emulated"),
    mechanism: z.string(),
    witness: z.string(),
  }),
  z.object({ kind: z.literal("not-applicable"), reason: z.string() }),
]);

const attachmentPostureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("supported"),
    kinds: z.array(z.enum(["image", "video", "audio"])),
    mechanism: z.string(),
    witness: z.string(),
  }),
  z.object({ kind: z.literal("text-only"), note: z.string() }),
  z.object({ kind: z.literal("not-applicable"), reason: z.string() }),
]);

const vendorPostureSchema = z.object({
  vendor: z
    .string()
    .describe(
      "Gateway creator prefix, e.g. 'anthropic' in 'anthropic/claude-sonnet-5'",
    ),
  label: z.string().describe("Human-readable vendor name, e.g. 'Anthropic'"),
  models: z
    .array(z.string())
    .describe(
      "Catalog gateway model ids this vendor ships, e.g. ['anthropic/claude-sonnet-5']",
    ),
  cache: cachePostureSchema,
  reasoning: reasoningPostureSchema,
  structuredOutput: structuredOutputPostureSchema,
  attachments: attachmentPostureSchema,
});

export const modelCapabilityList = registerCapability({
  name: "list_model_capabilities",
  domain: "model",
  description:
    "List the provider capability posture matrix — per vendor, how its prompt cache is engaged (explicit opt-in vs implicit), how its reasoning budget is controlled, how structured output is obtained, and which attachment kinds it accepts. Query before routing work to a BYOK-configured provider.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "mcp", "unit", "docs"],
  scoped: false,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    vendor: z
      .string()
      .optional()
      .describe(
        "Filter to one vendor by its gateway creator prefix (e.g. 'anthropic'). Omit for the full matrix.",
      ),
    model: z
      .string()
      .optional()
      .describe(
        "Resolve the posture that applies to a specific gateway model id (e.g. 'anthropic/claude-sonnet-5'). Takes precedence over `vendor`.",
      ),
  }),
  output: z.object({
    vendors: z.array(vendorPostureSchema),
    /**
     * Echoed so a caller that filtered by an id the matrix does not know can
     * tell "no posture declared" apart from "empty matrix" — an unknown
     * provider must read as unknown, never as supported.
     */
    unknownFilter: z
      .string()
      .nullable()
      .describe(
        "The vendor/model filter that matched no posture row, or null when the filter resolved (or none was supplied)",
      ),
  }),
});

export type ModelCapabilityListInput = z.output<
  typeof modelCapabilityList.input
>;
export type ModelCapabilityListOutput = z.output<
  typeof modelCapabilityList.output
>;
