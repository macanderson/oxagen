import { z } from "zod";
import { registerCapability } from "../registry";

// ── code.map — structured code-map retrieval ──────────────────────────────────
//
// Answers "give me everything related to <concept>" in one structured bundle:
//   • files       — source files semantically relevant to the query
//   • symbols     — top-level symbols in those files (functions, classes, types)
//   • calls       — CALLS edges between matched symbols (populated when present)
//   • recentChanges — commits that modified matched files (populated when present)
//
// Semantic matching uses the same vector index as graph.search. CALLS edges and
// Commit edges are traversed when present and degrade gracefully (empty arrays)
// when the in-flight code-graph ingestion tasks have not yet landed them.

export const codeMap = registerCapability({
  name: "get_code_map",
  domain: "code",
  description:
    "Return a structured code-map bundle for a natural-language concept query: " +
    "semantically matched source files, their top-level symbols, inter-symbol " +
    "call edges, and recent commits that touched the matched files. " +
    "Prefer this over `grep` or `bash find` for conceptual or multi-word queries " +
    "like 'everything related to payments' or 'auth session handling'.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "code" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    query: z
      .string()
      .min(1)
      .max(1000)
      .describe("Natural-language concept query, e.g. 'payments', 'auth session handling'"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Maximum number of files to return (1–50, default 20)"),
    kinds: z
      .array(z.enum(["file", "symbol", "chunk", "commit"]))
      .optional()
      .describe(
        "Optional filter for which result kinds to include. Omit to include all. " +
          "'commit' controls whether recentChanges is populated.",
      ),
    domain: z
      .string()
      .optional()
      .describe(
        "Optional domain label filter — only return nodes whose `domain` property matches " +
          "(e.g. 'billing', 'auth'). Silently ignored if the `domain` property is absent.",
      ),
  }),
  output: z.object({
    files: z.array(
      z.object({
        nodeId: z.string(),
        path: z.string(),
        language: z.string(),
        displayName: z.string(),
        domain: z.string().optional(),
        score: z.number(),
      }),
    ),
    symbols: z.array(
      z.object({
        nodeId: z.string(),
        name: z.string(),
        kind: z.string(),
        path: z.string(),
        startLine: z.number(),
        endLine: z.number(),
        signature: z.string(),
        docComment: z.string().optional(),
        domain: z.string().optional(),
        score: z.number(),
      }),
    ),
    calls: z.array(
      z.object({
        callerNodeId: z.string(),
        calleeNodeId: z.string(),
        callerName: z.string(),
        calleeName: z.string(),
      }),
    ),
    recentChanges: z.array(
      z.object({
        commitSha: z.string(),
        message: z.string(),
        authorName: z.string(),
        committedAt: z.string(),
        modifiedFiles: z.array(z.string()),
      }),
    ),
  }),
});

export type CodeMapInput = z.output<typeof codeMap.input>;
export type CodeMapOutput = z.output<typeof codeMap.output>;
