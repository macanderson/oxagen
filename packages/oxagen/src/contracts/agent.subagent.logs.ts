import { z } from "zod";
import { registerCapability } from "../registry";

// Render directive matching the file-attachment chat component (a downloadable
// document card — NOT a zip; the user asked for a real document).
const fileRenderDirective = z.object({
  componentId: z.literal("file-attachment"),
  props: z.object({
    url: z.string(),
    name: z.string(),
    kind: z.literal("document"),
    mimeType: z.string(),
    sizeBytes: z.number(),
  }),
});

/**
 * agent.subagent.logs — produce a downloadable log document for a fan-out
 * (e.g. a research swarm). It reads every child run's full input + output via
 * agent.subagent.aggregate (children) and writes a markdown log — traceable
 * down to each subagent's query and its individual results — to a downloadable
 * asset, served through the access-controlled /api/v1/assets/<publicId> route.
 *
 * This is the "download individual swarm subagent logfiles" capability: full
 * activity, down to individual queries and results.
 */
export const agentSubagentLogs = registerCapability({
  name: "get_subagent_logs",
  domain: "agent",
  description:
    "Generate a downloadable markdown logfile for a fan-out (research swarm or any agent.subagent.dispatch). " +
    "Includes every child subagent's capability, status, timing, full input (e.g. the search query) and full " +
    "output (e.g. each result), so the run is traceable down to individual queries and results.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  agent: { requiresApproval: false, riskLevel: "low", category: "agent" },
  scoped: true,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  consumes: ["swarm.id"],
  produces: ["asset.id", "document.text"],
  chainHints: [],
  input: z.object({
    fanoutId: z
      .string()
      .describe("The fan-out / dispatch id (the dispatchId from research.swarm.start or agent.subagent.dispatch)"),
    title: z
      .string()
      .max(200)
      .optional()
      .describe("Optional title for the log document"),
  }),
  output: z.object({
    assetId: z.string(),
    publicId: z.string(),
    childCount: z.number(),
    mimeType: z.string(),
    sizeBytes: z.number(),
    url: z.string(),
    serveUrl: z.string(),
    render: fileRenderDirective,
  }),
});

export type AgentSubagentLogsInput = z.output<typeof agentSubagentLogs.input>;
export type AgentSubagentLogsOutput = z.output<typeof agentSubagentLogs.output>;
