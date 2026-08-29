import { z } from "zod";
import { registerCapability } from "../registry";
import { agentMemoryRecordSchema } from "./agent.memory.list";
import { memoryClassEnum, memoryKindSchema } from "./agent.memory.model";

/**
 * agent.memory.remember — the one-shot "just remember this" entry point.
 *
 * Where `agent.memory.write` demands every field up front, `remember` takes raw
 * text and infers the memory `kind` and `weight` with a small classifier when
 * the caller does not pin them, then embeds and writes the result. This is what
 * the CLI `/remember <text>` slash command and `oxagen remember` call so a human
 * can capture a lesson without learning the weight/kind taxonomy.
 *
 * The write lands on the workspace-scoped Neo4j `:AgentMemory` store — the same
 * nodes `agent.memory.list`/`recall` read — so a memory captured from the CLI is
 * immediately synced to the workspace and visible in Knowledge → Memories.
 */
export const agentMemoryRemember = registerCapability({
  name: "save_memory",
  domain: "agent",
  description:
    "Capture a free-text memory: infer its kind + weight (unless pinned), embed it, and write it to the workspace AgentMemory graph. Backs the CLI /remember command.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    text: z
      .string()
      .min(1)
      .max(2000)
      .describe("The lesson to remember, in the user's own words"),
    nodeRef: z
      .string()
      .optional()
      .describe(
        "Graph node id to anchor the memory on. Defaults to the 'user-memory' bucket for free-form notes with no code anchor.",
      ),
    memoryClass: memoryClassEnum
      .optional()
      .describe(
        "Pin the epistemic class; omit to let the classifier infer it (defaults to OBSERVATION)",
      ),
    memoryKind: memoryKindSchema
      .optional()
      .describe(
        "Pin the content-domain kind; omit to let the classifier infer it",
      ),
    enforcementScore: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Enforcement (1-100) when memoryClass is RULE"),
    source: z
      .enum(["user", "feature", "fix", "exception-watcher", "bug-report"])
      .default("user")
      .describe("Provenance; defaults to 'user' for a human-captured memory"),
    relatedNodeIds: z
      .array(z.string())
      .max(20)
      .optional()
      .describe(
        "KnowledgeNode publicIds this memory is about — creates :ABOUT edges",
      ),
  }),
  output: z.object({
    memory: agentMemoryRecordSchema,
    inferred: z
      .object({
        memoryClass: memoryClassEnum,
        memoryKind: memoryKindSchema,
        classified: z
          .boolean()
          .describe(
            "true when class/kind were inferred by the model rather than supplied or defaulted",
          ),
      })
      .describe(
        "The class + kind actually used, and whether the model inferred them",
      ),
  }),
});

// z.input (not z.output): `source` has a .default, so the value a *caller*
// supplies leaves it optional. The handler applies the `?? "user"` fallback
// itself, so typing the handler input as the caller-facing shape matches the
// real contract — and a parsed (source-present) object the kernel passes still
// satisfies it.
export type AgentMemoryRememberInput = z.input<
  typeof agentMemoryRemember.input
>;
export type AgentMemoryRememberOutput = z.output<
  typeof agentMemoryRemember.output
>;
