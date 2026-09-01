import { z } from "zod";
import { registerCapability } from "../registry";

export const toolDeclarationList = registerCapability({
  name: "list_tool_declarations",
  domain: "tool",
  description:
    "List the tool declarations registered in the active workspace, each with its pinned active version's schema facts (read-only flag, risk grade, policy group, checksum)",
  mode: "sync",
  surfaces: ["api", "agent", "mcp"],
  layers: ["schema", "api", "docs", "mcp", "unit"],
  scoped: true,
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
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z
    .object({
      source: z
        .enum(["builtin", "custom", "mcp", "foundry"])
        .optional()
        .describe("Only return declarations from this source"),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum number of tools to return (default 50, max 200)"),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Pagination offset (number of tools to skip)"),
    })
    .strict(),
  output: z
    .object({
      tools: z.array(
        z
          .object({
            id: z.string().describe("Public tool ID (tol_…)"),
            slug: z.string(),
            name: z.string(),
            description: z.string().nullable(),
            source: z.string(),
            enabled: z.boolean(),
            readOnly: z
              .boolean()
              .nullable()
              .describe("From the active version; null when none is pinned"),
            riskGrade: z.string().nullable(),
            policyGroup: z.string().nullable(),
            version: z
              .number()
              .int()
              .nullable()
              .describe("Active version number; null when none is pinned"),
            checksum: z.string().nullable(),
            updatedAt: z.string().datetime(),
          })
          .strict(),
      ),
      total: z
        .number()
        .int()
        .describe("Total declarations in the workspace matching the filter"),
    })
    .strict(),
});

export type ToolDeclarationListInput = z.output<
  typeof toolDeclarationList.input
>;
export type ToolDeclarationListOutput = z.output<
  typeof toolDeclarationList.output
>;
