import { z } from "zod";
import { registerCapability } from "../registry";

export const schemaChat = registerCapability({
  name: "run_schema_chat",
  domain: "schema",
  description:
    "AI iterative builder turn: takes conversation + current draft; returns assistant message + proposed mutation tool calls.",
  mode: "sync",
  surfaces: ["api", "agent"] as const,
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "schema" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    message: z.string().min(1).max(10000),
    conversationId: z.string().optional(),
    draftVersionId: z.string().optional(),
  }),
  output: z.object({
    assistantMessage: z.string(),
    proposedMutations: z
      .array(
        z.object({
          capability: z
            .string()
            .describe("Capability name, e.g. upsert_schema_label"),
          input: z.record(z.string(), z.unknown()),
        }),
      )
      .optional(),
    conversationId: z.string(),
  }),
});

export type SchemaChatInput = z.output<typeof schemaChat.input>;
export type SchemaChatOutput = z.output<typeof schemaChat.output>;
