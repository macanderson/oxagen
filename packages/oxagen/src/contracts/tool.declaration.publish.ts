import { z } from "zod";
import { registerCapability } from "../registry";

export const toolDeclarationPublish = registerCapability({
  name: "publish_tool_declaration",
  domain: "tool",
  description:
    "Publish a tool declaration into the workspace agent-asset registry — upserts the agent.tools row by (workspace, name) and creates a new immutable tool_versions row when the canonical manifest changed. Idempotent on an unchanged manifest.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "docs", "unit"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z
    .object({
      name: z
        .string()
        .min(1)
        .describe(
          "Tool name (snake_case identifier, e.g. read_file) — the workspace-unique key",
        ),
      description: z.string().min(1).describe("What the tool does"),
      input_schema: z
        .record(z.unknown())
        .describe("JSON Schema for the tool's input parameters"),
      read_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("True when the tool mutates nothing"),
      risk_grade: z
        .enum(["low", "medium", "high", "critical"])
        .describe("Declared risk grade of invoking this tool"),
      policy_group: z
        .string()
        .optional()
        .describe("Policy group the tool's per-tool toggles key on"),
      source: z
        .enum(["builtin", "custom", "mcp", "foundry"])
        .describe("Where the declaration came from"),
      manifest: z
        .record(z.unknown())
        .describe("The full declared manifest body, verbatim"),
    })
    .strict(),
  output: z
    .object({
      publicId: z.string().describe("Public tool ID (tol_…)"),
      slug: z.string(),
      version: z.number().int().positive(),
      checksum: z
        .string()
        .describe("SHA-256 hex over the canonical (sorted-key) manifest JSON"),
      published: z
        .boolean()
        .describe(
          "false when the latest version already carries this checksum (idempotent)",
        ),
    })
    .strict(),
});

export type ToolDeclarationPublishInput = z.output<
  typeof toolDeclarationPublish.input
>;
export type ToolDeclarationPublishOutput = z.output<
  typeof toolDeclarationPublish.output
>;
