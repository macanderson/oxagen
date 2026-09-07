import { describe, it, expect } from "vitest";
import {
  agentDefinitionSchema,
  agentDefinitionConfigSchema,
  agentInstanceSchema,
  agentLogSchema,
  debugOptionsSchema,
  graphAccessSchema,
  graphBudgetSchema,
  parseAgentDefinition,
  parseAgentDefinitionConfig,
  agentToolTypeSchema,
  agentLogEntryTypeSchema,
} from "./agent-schema";

const graph = {
  ontologyId: "ont_1",
  retrieval: { strategy: "hybrid" as const },
  budget: { maxHops: 3, maxNodes: 50 },
};

const baseDefinition = {
  id: "agt_1",
  name: "Interactive",
  description: "Answers questions",
  version: "1",
  graph,
  agentTools: [{ type: "function" as const, ref: "recall_memory" }],
  tenantId: "org_1",
  workspaceId: "wks_1",
};

describe("graphAccessSchema", () => {
  it("defaults mode to read", () => {
    const parsed = graphAccessSchema.parse(graph);
    expect(parsed.mode).toBe("read");
  });

  it("rejects a relevance score outside 0–1", () => {
    expect(() =>
      graphBudgetSchema.parse({ maxHops: 1, maxNodes: 1, minRelevance: 2 }),
    ).toThrow();
  });

  it("requires a positive maxNodes", () => {
    expect(() =>
      graphBudgetSchema.parse({ maxHops: 1, maxNodes: 0 }),
    ).toThrow();
  });
});

describe("agentDefinitionSchema", () => {
  it("applies the deploy default", () => {
    const parsed = agentDefinitionSchema.parse(baseDefinition);
    expect(parsed.deploymentStatus).toBe("inactive");
    expect(parsed.graph.mode).toBe("read");
  });

  it("rejects an empty name", () => {
    expect(() =>
      agentDefinitionSchema.parse({ ...baseDefinition, name: "" }),
    ).toThrow();
  });

  it("round-trips through parseAgentDefinition", () => {
    const parsed = parseAgentDefinition({
      ...baseDefinition,
      deploymentStatus: "active",
    });
    expect(parsed.deploymentStatus).toBe("active");
  });
});

describe("agentDefinitionConfigSchema", () => {
  it("is the version-body subset of the definition", () => {
    const config = agentDefinitionConfigSchema.parse({
      graph,
      agentTools: [{ type: "function", ref: "code.read" }],
      instructions: "Be helpful.",
    });
    expect(config).not.toHaveProperty("id");
    expect(config.instructions).toBe("Be helpful.");
    expect(parseAgentDefinitionConfig(config).agentTools).toHaveLength(1);
  });
});

describe("debugOptionsSchema", () => {
  it("defaults the master switch to off", () => {
    expect(debugOptionsSchema.parse({}).enabled).toBe(false);
  });
});

describe("agentInstanceSchema", () => {
  it("validates a running instance with live state", () => {
    const parsed = agentInstanceSchema.parse({
      runId: "aex_1",
      definitionId: "agt_1",
      definitionVersion: "1",
      status: "running",
      debug: { enabled: true, traceToolIO: true },
      state: { step: 2 },
      startedAt: "2026-06-15T00:00:00.000Z",
    });
    expect(parsed.status).toBe("running");
    expect(parsed.parentRunId).toBeUndefined();
  });

  it("rejects an unknown run status", () => {
    expect(() =>
      agentInstanceSchema.parse({
        runId: "aex_1",
        definitionId: "agt_1",
        definitionVersion: "1",
        status: "exploded",
        debug: { enabled: false },
        state: {},
        startedAt: "2026-06-15T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("agentLogSchema", () => {
  it("validates an append-only log with typed entries", () => {
    const parsed = agentLogSchema.parse({
      id: "log_1",
      runId: "aex_1",
      definitionId: "agt_1",
      definitionVersion: "1",
      tenantId: "org_1",
      workspaceId: "wks_1",
      entries: [
        {
          id: "e1",
          runId: "aex_1",
          timestamp: "2026-06-15T00:00:00.000Z",
          type: "lifecycle",
          level: "info",
          message: "run started",
        },
        {
          id: "e2",
          runId: "aex_1",
          timestamp: "2026-06-15T00:00:01.000Z",
          type: "tool_call",
          level: "debug",
          message: "called code.read",
          data: { tool: "code.read" },
        },
      ],
      startedAt: "2026-06-15T00:00:00.000Z",
    });
    expect(parsed.entries).toHaveLength(2);
  });

  it("rejects an unknown entry type", () => {
    expect(() =>
      agentLogSchema.parse({
        id: "log_1",
        runId: "aex_1",
        definitionId: "agt_1",
        definitionVersion: "1",
        tenantId: "org_1",
        entries: [
          {
            id: "e1",
            runId: "aex_1",
            timestamp: "2026-06-15T00:00:00.000Z",
            type: "telepathy",
            level: "info",
            message: "nope",
          },
        ],
        startedAt: "2026-06-15T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

// ADR-041 excised the execution runtime, so the definition record carries no
// field describing HOW an agent runs. A grant names something the platform can
// actually gate — a capability or a registered MCP server — and the log
// vocabulary has no delegation entry, because there is no delegation.
describe("agent definitions describe governance, not execution", () => {
  it("allows exactly the two gateable tool kinds", () => {
    expect(agentToolTypeSchema.options).toEqual(["function", "mcp_server"]);
  });

  it.each(["skill", "agent", "sandbox", "code"])(
    "rejects the removed %s tool kind",
    (kind) => {
      expect(agentToolTypeSchema.safeParse(kind).success).toBe(false);
    },
  );

  it("rejects an agentTool of a removed kind inside a definition", () => {
    expect(() =>
      agentDefinitionConfigSchema.parse({
        graph,
        agentTools: [{ type: "skill", ref: "coding" }],
      }),
    ).toThrow();
  });

  it("carries no subagent_call log entry type", () => {
    expect(agentLogEntryTypeSchema.options).not.toContain("subagent_call");
    expect(agentLogEntryTypeSchema.options).toContain("tool_call");
  });

  it.each(["skills", "sandbox", "environment", "codeMode", "agentType"])(
    "has no %s field on the versioned config body",
    (field) => {
      expect(agentDefinitionConfigSchema.keyof().options).not.toContain(field);
    },
  );
});
