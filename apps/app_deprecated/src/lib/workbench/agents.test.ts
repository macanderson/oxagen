/**
 * agents.test.ts — the deprecated workbench's agent seam after ADR-192.
 *
 * The capabilities it wrapped are gone. Reads answer an empty roster and
 * every write refuses with `AgentDefinitionsRemovedError`, without calling
 * the kernel.
 */
import { describe, it, expect } from "vitest";
import {
  AgentDefinitionsRemovedError,
  createAgent,
  deployAgent,
  ensureAgentSummaries,
  getAgent,
  listAgents,
  publishAgent,
  suggestAgentDefinition,
  summarizeAgent,
  updateAgent,
  type AgentListRow,
} from "./agents";
import type { WorkbenchCtx } from "./scope";

const ctx: WorkbenchCtx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app",
  messageId: null,
};

const config = {
  graph: {
    ontologyId: "ont_1",
    mode: "read" as const,
    retrieval: { strategy: "hybrid" as const },
    budget: { maxHops: 1, maxNodes: 1 },
  },
  agentTools: [],
};

describe("workbench/agents.ts after ADR-192", () => {
  it("lists no agents", async () => {
    await expect(listAgents(ctx)).resolves.toEqual([]);
    await expect(listAgents(ctx, "active")).resolves.toEqual([]);
  });

  it("returns the rows it was given unchanged when asked for summaries", async () => {
    const rows = [{ agentId: "agt_1", summary: null }] as AgentListRow[];
    await expect(ensureAgentSummaries(ctx, rows)).resolves.toBe(rows);
  });

  it.each([
    ["getAgent", () => getAgent(ctx, "agt_1")],
    [
      "suggestAgentDefinition",
      () => suggestAgentDefinition(ctx, { description: "audits budgets" }),
    ],
    ["createAgent", () => createAgent(ctx, { slug: "a", name: "A", config })],
    ["updateAgent", () => updateAgent(ctx, { agentId: "agt_1", config })],
    ["summarizeAgent", () => summarizeAgent(ctx, "agt_1")],
    ["publishAgent", () => publishAgent(ctx, "agt_1")],
    ["deployAgent", () => deployAgent(ctx, "agt_1", "active")],
  ])("%s refuses with AgentDefinitionsRemovedError", async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(AgentDefinitionsRemovedError);
  });
});
