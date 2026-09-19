// agent.handlers.test.ts — handler invocation tests for all agent-domain tools.
//
// Pattern: vi.mock the kernel `invoke` and the context seam `buildContext` so
// that each default-export handler can be called without a live runtime.
// Each test asserts: (a) buildContext was called, (b) invoke was called once
// with the correct contract name + args + { surface: "mcp" }, (c) handler
// returns the parsed result.
//
// Fake outputs satisfy each contract's output Zod schema so `.output.parse()`
// in the handler passes cleanly.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

// ── agent.approval.list ───────────────────────────────────────────────────────

import handler_agentApprovalList, {
  schema as agentApprovalListSchema,
  metadata as agentApprovalListMetadata,
} from "./agent.approval.list";

describe("agent.approval.list handler", () => {
  const validOutput = {
    items: [
      {
        id: "apr_0123456789abcdefghjkmn",
        runId: null,
        tool: "create_workspace",
        requester: "usr_0123456789abcdefghjkmn",
        createdAt: "2026-09-13T10:00:00.000Z",
        expiresAt: "2026-09-13T10:05:00.000Z",
        // A row the chat approval gate wrote: no mandate hop, no parking rule,
        // and no auto-approval rule read against it.
        mandateId: null,
        autoEligibility: null,
        chain: { agentKey: null, rule: null },
      },
    ],
    nextCursor: null,
  };

  it("exports the contract's schema and read-only metadata", () => {
    expect(Object.keys(agentApprovalListSchema).sort()).toEqual([
      "cursor",
      "limit",
      "runId",
    ]);
    expect(agentApprovalListMetadata.name).toBe("list_approvals");
    expect(agentApprovalListMetadata.annotations?.readOnlyHint).toBe(true);
  });

  it("calls buildContext then invoke with 'list_approvals', the args and surface 'mcp'", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { runId: undefined, limit: 20, cursor: undefined };
    const result = await handler_agentApprovalList(args);
    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("list_approvals", args, fakeCtx, {
      surface: "mcp",
    });
    expect(result).toEqual(validOutput);
  });

  it("carries the mandate hop and the parking rule of a mandate-gate row", async () => {
    const mandateRow = {
      items: [
        {
          ...validOutput.items[0],
          mandateId: "mnd_0123456789abcdefghjkmn",
          autoEligibility: {
            ruleId: "small-vendor-payments",
            ok: false,
            reasons: ["measure_above_ceiling:amount"],
            floor: false,
          },
          chain: {
            agentKey: null,
            rule: "mandate:mnd_0123456789abcdefghjkmn:human_above:usd",
          },
        },
      ],
      nextCursor: null,
    };
    mocks.invoke.mockResolvedValue(mandateRow);
    const result = await handler_agentApprovalList({
      runId: undefined,
      limit: 50,
      cursor: undefined,
    });
    expect(result).toEqual(mandateRow);
  });

  it("refuses an output that carries a row uuid instead of a public id", async () => {
    mocks.invoke.mockResolvedValue({
      items: [
        {
          ...validOutput.items[0],
          id: "0195b7c8-1e6e-7c3a-9f0e-0a1b2c3d4e5f",
        },
      ],
      nextCursor: null,
    });
    await expect(
      handler_agentApprovalList({
        runId: undefined,
        limit: 50,
        cursor: undefined,
      }),
    ).rejects.toThrow();
  });

  it("propagates invoke errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("invoke failed"));
    await expect(
      handler_agentApprovalList({
        runId: undefined,
        limit: 50,
        cursor: undefined,
      }),
    ).rejects.toThrow("invoke failed");
  });
});

// ── agent.approval.list_resolved (#3153) ───────────────────────────────────

import handler_agentApprovalListResolved, {
  schema as agentApprovalListResolvedSchema,
  metadata as agentApprovalListResolvedMetadata,
} from "./agent.approval.list_resolved";

describe("agent.approval.list_resolved handler", () => {
  const validOutput = {
    items: [
      {
        id: "apr_0123456789abcdefghjkmn",
        runId: null,
        tool: "stripe__create_payment",
        requester: null,
        createdAt: "2026-09-13T10:00:00.000Z",
        expiresAt: "2026-09-13T10:05:00.000Z",
        resolvedAt: "2026-09-13T10:00:01.000Z",
        resolution: "approved",
        resolvedBy: "policy:small-vendor-payments",
        autoRuleId: "small-vendor-payments",
        autoEligibility: {
          ruleId: "small-vendor-payments",
          ok: true,
          reasons: [],
          floor: false,
        },
        mandateId: null,
        chain: { agentKey: null, rule: null },
      },
    ],
    nextCursor: null,
  };

  it("exports the contract's schema and read-only metadata", () => {
    expect(Object.keys(agentApprovalListResolvedSchema).sort()).toEqual([
      "cursor",
      "limit",
      "runId",
      "since",
      "until",
    ]);
    expect(agentApprovalListResolvedMetadata.name).toBe(
      "list_resolved_approvals",
    );
    expect(agentApprovalListResolvedMetadata.annotations?.readOnlyHint).toBe(
      true,
    );
  });

  it("calls buildContext then invoke with 'list_resolved_approvals', the args and surface 'mcp'", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = {
      runId: undefined,
      since: undefined,
      until: undefined,
      limit: 20,
      cursor: undefined,
    };
    const result = await handler_agentApprovalListResolved(args);
    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_resolved_approvals",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toEqual(validOutput);
  });

  it("propagates invoke errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("invoke failed"));
    await expect(
      handler_agentApprovalListResolved({
        runId: undefined,
        since: undefined,
        until: undefined,
        limit: 50,
        cursor: undefined,
      }),
    ).rejects.toThrow("invoke failed");
  });
});

// ── agent.approval.resolve ────────────────────────────────────────────────────

import handler_agentApprovalResolve, {
  schema as agentApprovalResolveSchema,
  metadata as agentApprovalResolveMetadata,
} from "./agent.approval.resolve";

describe("agent.approval.resolve handler", () => {
  // A row the chat approval gate wrote settles no mandate reservation.
  const validOutput = {
    approvalId: "apr_1",
    resolution: "approved" as const,
    mandate: null,
  };

  it("exports schema and metadata", () => {
    expect(agentApprovalResolveSchema).toBeDefined();
    expect(agentApprovalResolveMetadata.name).toBe("resolve_approval");
  });

  it("calls buildContext then invoke with correct contract name and args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = {
      approvalId: "apr_1",
      decision: "approved" as const,
      note: undefined,
    };
    const result = await handler_agentApprovalResolve(args);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "resolve_approval",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({
      approvalId: "apr_1",
      resolution: "approved",
      mandate: null,
    });
  });

  it("returns the mandate settlement of a mandate-gate row", async () => {
    const settled = {
      approvalId: "apr_1",
      resolution: "approved" as const,
      mandate: {
        mandateId: "mnd_0123456789abcdefghjkmn",
        reserved: [{ measure: "spend", value: "2.50", unitOrCurrency: "USD" }],
        outcome: "held" as const,
      },
    };
    mocks.invoke.mockResolvedValue(settled);
    const result = await handler_agentApprovalResolve({
      approvalId: "apr_1",
      decision: "approved" as const,
      note: undefined,
    });
    expect(result).toEqual(settled);
  });

  it("propagates invoke errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("invoke failed"));
    await expect(
      handler_agentApprovalResolve({
        approvalId: "x",
        decision: "denied",
        note: undefined,
      }),
    ).rejects.toThrow("invoke failed");
  });
});

// ── agent.mcp.list ────────────────────────────────────────────────────────────

import handler_agentMcpList, {
  schema as agentMcpListSchema,
  metadata as agentMcpListMetadata,
} from "./agent.mcp.list";

describe("agent.mcp.list handler", () => {
  const validOutput = { servers: [] };

  it("exports schema and metadata", () => {
    expect(agentMcpListSchema).toBeDefined();
    expect(agentMcpListMetadata.name).toBe("list_mcp_servers");
  });

  it("calls invoke with 'list_mcp_servers' and empty args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const result = await handler_agentMcpList({});

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("list_mcp_servers", {}, fakeCtx, {
      surface: "mcp",
    });
    expect(result).toMatchObject({ servers: [] });
  });
});

// ── agent.mcp.register ────────────────────────────────────────────────────────

import handler_agentMcpRegister, {
  schema as agentMcpRegisterSchema,
  metadata as agentMcpRegisterMetadata,
} from "./agent.mcp.register";

describe("agent.mcp.register handler", () => {
  const validOutput = {
    mcpServerId: "srv_1",
    healthStatus: "healthy" as const,
    discoveredTools: ["tool_a", "tool_b"],
  };

  it("exports schema and metadata", () => {
    expect(agentMcpRegisterSchema).toBeDefined();
    expect(agentMcpRegisterMetadata.name).toBe("register_mcp_server");
  });

  it("calls invoke with correct args and forwards result", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = {
      name: "Test MCP",
      transportType: "streamable-http" as const,
      endpointUrl: "https://mcp.example.com/mcp",
      authStrategy: "none" as const,
      authConfig: undefined,
    };
    const result = await handler_agentMcpRegister(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "register_mcp_server",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({
      mcpServerId: "srv_1",
      healthStatus: "healthy",
    });
  });
});

// ── agent.memory.recall ───────────────────────────────────────────────────────

import handler_agentMemoryRecall, {
  schema as agentMemoryRecallSchema,
  metadata as agentMemoryRecallMetadata,
} from "./agent.memory.recall";

describe("agent.memory.recall handler", () => {
  const validOutput = { memories: [] };

  it("exports schema and metadata", () => {
    expect(agentMemoryRecallSchema).toBeDefined();
    expect(agentMemoryRecallMetadata.name).toBe("recall_memory");
  });

  it("calls invoke with recall args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = {
      query: "user prefs",
      memoryClass: "RULE" as const,
      minEnforcement: 70,
      limit: 10,
      nodeRef: undefined,
      executionRef: undefined,
      agentId: undefined,
    };
    await handler_agentMemoryRecall(args);

    expect(mocks.invoke).toHaveBeenCalledWith("recall_memory", args, fakeCtx, {
      surface: "mcp",
    });
  });
});

// ── agent.memory.write ────────────────────────────────────────────────────────

import handler_agentMemoryWrite, {
  schema as agentMemoryWriteSchema,
  metadata as agentMemoryWriteMetadata,
} from "./agent.memory.write";

describe("agent.memory.write handler", () => {
  const validOutput = {
    memoryId: "mem_1",
    nodeRef: "node-abc",
    edgesCreated: 0,
  };

  it("exports schema and metadata", () => {
    expect(agentMemoryWriteSchema).toBeDefined();
    expect(agentMemoryWriteMetadata.name).toBe("write_memory");
  });

  it("calls invoke with write args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = {
      nodeRef: "node-abc",
      memoryClass: "RULE" as const,
      memoryKind: "gotcha" as const,
      enforcementScore: 70,
      lesson: "Always flush cache",
      source: "fix" as const,
      relatedNodeIds: undefined,
    };
    const result = await handler_agentMemoryWrite(args);

    expect(mocks.invoke).toHaveBeenCalledWith("write_memory", args, fakeCtx, {
      surface: "mcp",
    });
    expect(result).toMatchObject({ memoryId: "mem_1" });
  });
});

// ── agent.tool.list ───────────────────────────────────────────────────────────

import handler_agentToolList, {
  schema as agentToolListSchema,
  metadata as agentToolListMetadata,
} from "./agent.tool.list";

describe("agent.tool.list handler", () => {
  const validOutput = { tools: [] };

  it("exports schema and metadata", () => {
    expect(agentToolListSchema).toBeDefined();
    expect(agentToolListMetadata.name).toBe("list_agent_tools");
  });

  it("calls invoke with tool list args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { includeExternal: true };
    await handler_agentToolList(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_agent_tools",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── agent.definition.create ───────────────────────────────────────────────────

import handler_agentDefinitionCreate, {
  metadata as agentDefinitionCreateMetadata,
} from "./agent.definition.create";

describe("agent.definition.create handler", () => {
  const validOutput = {
    agentId: "agt_1",
    publicId: "agt_1",
    slug: "a",
    version: 1,
  };

  it("exports metadata with the contract name", () => {
    expect(agentDefinitionCreateMetadata.name).toBe("create_agent_def");
  });

  it("calls buildContext then invoke and parses output", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = {
      slug: "a",
      name: "A",
      agentType: "custom",
      config: {
        graph: {
          ontologyId: "o",
          mode: "read",
          retrieval: { strategy: "hybrid" },
          budget: { maxHops: 1, maxNodes: 1 },
        },
        agentTools: [],
      },
    };
    const result = await handler_agentDefinitionCreate(args as never);
    expect(mocks.buildContext).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "create_agent_def",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject(validOutput);
  });
});

// ── agent.definition.update ───────────────────────────────────────────────────

import handler_agentDefinitionUpdate, {
  metadata as agentDefinitionUpdateMetadata,
} from "./agent.definition.update";

describe("agent.definition.update handler", () => {
  it("exports metadata and forwards to invoke", async () => {
    expect(agentDefinitionUpdateMetadata.name).toBe("update_agent_def");
    mocks.invoke.mockResolvedValue({
      agentId: "agt_1",
      version: 2,
      isPublished: false,
    });
    const args = {
      agentId: "agt_1",
      config: {
        graph: {
          ontologyId: "o",
          mode: "read",
          retrieval: { strategy: "hybrid" },
          budget: { maxHops: 1, maxNodes: 1 },
        },
        agentTools: [],
      },
    };
    const result = await handler_agentDefinitionUpdate(args as never);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "update_agent_def",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result.version).toBe(2);
  });
});

// ── agent.definition.publish ──────────────────────────────────────────────────

import handler_agentDefinitionPublish, {
  metadata as agentDefinitionPublishMetadata,
} from "./agent.definition.publish";

describe("agent.definition.publish handler", () => {
  it("exports metadata and forwards to invoke", async () => {
    expect(agentDefinitionPublishMetadata.name).toBe("publish_agent_def");
    mocks.invoke.mockResolvedValue({
      agentId: "agt_1",
      version: 1,
      checksum: "x",
      activeVersionId: "v",
    });
    const args = { agentId: "agt_1" };
    const result = await handler_agentDefinitionPublish(args as never);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "publish_agent_def",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result.checksum).toBe("x");
  });
});

// ── agent.definition.get ──────────────────────────────────────────────────────

import handler_agentDefinitionGet, {
  metadata as agentDefinitionGetMetadata,
} from "./agent.definition.get";

describe("agent.definition.get handler", () => {
  it("exports metadata and forwards to invoke", async () => {
    expect(agentDefinitionGetMetadata.name).toBe("get_agent_def");
    mocks.invoke.mockResolvedValue({
      agentId: "agt_1",
      publicId: "agt_1",
      slug: "a",
      agentKey: "org.ws.a",
      name: "A",
      description: null,
      agentType: "custom",
      status: "active",
      deploymentStatus: "active",
      version: 1,
      isPublished: true,
      managed: false,
      avatarUrl: null,
      summary: null,
      config: {
        graph: {
          ontologyId: "o",
          mode: "read",
          retrieval: { strategy: "hybrid" },
          budget: { maxHops: 1, maxNodes: 1 },
        },
        agentTools: [],
      },
    });
    const args = { agentId: "agt_1" };
    const result = await handler_agentDefinitionGet(args as never);
    expect(mocks.invoke).toHaveBeenCalledWith("get_agent_def", args, fakeCtx, {
      surface: "mcp",
    });
    expect(result.slug).toBe("a");
  });
});

// ── agent.definition.list ─────────────────────────────────────────────────────

import handler_agentDefinitionList, {
  metadata as agentDefinitionListMetadata,
} from "./agent.definition.list";

describe("agent.definition.list handler", () => {
  it("exports metadata and forwards to invoke", async () => {
    expect(agentDefinitionListMetadata.name).toBe("list_agent_defs");
    mocks.invoke.mockResolvedValue({ agents: [] });
    const result = await handler_agentDefinitionList({} as never);
    expect(mocks.invoke).toHaveBeenCalledWith("list_agent_defs", {}, fakeCtx, {
      surface: "mcp",
    });
    expect(result.agents).toEqual([]);
  });
});

// ── agent.deploy ──────────────────────────────────────────────────────────────

import handler_agentDeploy, {
  metadata as agentDeployMetadata,
} from "./agent.deploy";

describe("agent.deploy handler", () => {
  it("exports metadata and forwards to invoke", async () => {
    expect(agentDeployMetadata.name).toBe("deploy_agent");
    mocks.invoke.mockResolvedValue({
      agentId: "agt_1",
      deploymentStatus: "active",
    });
    const args = { agentId: "agt_1", deploymentStatus: "active" as const };
    const result = await handler_agentDeploy(args as never);
    expect(mocks.invoke).toHaveBeenCalledWith("deploy_agent", args, fakeCtx, {
      surface: "mcp",
    });
    expect(result.deploymentStatus).toBe("active");
  });
});
