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

// ── agent.approval.resolve ────────────────────────────────────────────────────

import handler_agentApprovalResolve, {
  schema as agentApprovalResolveSchema,
  metadata as agentApprovalResolveMetadata,
} from "./agent.approval.resolve";

describe("agent.approval.resolve handler", () => {
  const validOutput = { approvalId: "apr_1", resolution: "approved" as const };

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
    });
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

// ── agent.plan.approve ────────────────────────────────────────────────────────

import handler_agentPlanApprove, {
  schema as agentPlanApproveSchema,
  metadata as agentPlanApproveMetadata,
} from "./agent.plan.approve";

describe("agent.plan.approve handler", () => {
  const validOutput = { planId: "plan_1", status: "approved" };

  it("exports schema and metadata", () => {
    expect(agentPlanApproveSchema).toBeDefined();
    expect(agentPlanApproveMetadata.name).toBe("approve_plan");
  });

  it("calls invoke with plan approval args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = {
      planId: "plan_1",
      decision: "approve" as const,
      amendedSteps: undefined,
      note: undefined,
    };
    await handler_agentPlanApprove(args);

    expect(mocks.invoke).toHaveBeenCalledWith("approve_plan", args, fakeCtx, {
      surface: "mcp",
    });
  });
});

// ── agent.skill.list ─────────────────────────────────────────────────────────

import handler_agentSkillList, {
  schema as agentSkillListSchema,
  metadata as agentSkillListMetadata,
} from "./agent.skill.list";

describe("agent.skill.list handler", () => {
  const validOutput = { skills: [] };

  it("exports schema and metadata", () => {
    expect(agentSkillListSchema).toBeDefined();
    expect(agentSkillListMetadata.name).toBe("list_agent_skills");
  });

  it("calls invoke with skill list args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { filter: "my-skill" as string | undefined };
    await handler_agentSkillList(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_agent_skills",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });

  it("works with empty args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    await handler_agentSkillList({ filter: undefined });
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });
});

// ── agent.task.background.cancel ─────────────────────────────────────────────

import handler_agentTaskBackgroundCancel, {
  schema as agentTaskBackgroundCancelSchema,
  metadata as agentTaskBackgroundCancelMetadata,
} from "./agent.background_task.cancel";

describe("agent.task.background.cancel handler", () => {
  const validOutput = { taskId: "task_1", status: "cancelled" as const };

  it("exports schema and metadata", () => {
    expect(agentTaskBackgroundCancelSchema).toBeDefined();
    expect(agentTaskBackgroundCancelMetadata.name).toBe(
      "cancel_background_task",
    );
  });

  it("calls invoke with cancel args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { taskId: "task_1", reason: undefined };
    await handler_agentTaskBackgroundCancel(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "cancel_background_task",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── agent.task.background.read ────────────────────────────────────────────────

import handler_agentTaskBackgroundRead, {
  schema as agentTaskBackgroundReadSchema,
  metadata as agentTaskBackgroundReadMetadata,
} from "./agent.background_task.read";

describe("agent.task.background.read handler", () => {
  const validOutput = {
    taskId: "task_1",
    kind: "agent.run",
    status: "completed" as const,
    label: null,
    resultPayload: null,
    failureReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
  };

  it("exports schema and metadata", () => {
    expect(agentTaskBackgroundReadSchema).toBeDefined();
    expect(agentTaskBackgroundReadMetadata.name).toBe("get_background_task");
  });

  it("calls invoke with read args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { taskId: "task_1" };
    const result = await handler_agentTaskBackgroundRead(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_background_task",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({ taskId: "task_1", status: "completed" });
  });
});

// ── agent.task.background.start ───────────────────────────────────────────────

import handler_agentTaskBackgroundStart, {
  schema as agentTaskBackgroundStartSchema,
  metadata as agentTaskBackgroundStartMetadata,
} from "./agent.background_task.start";

describe("agent.task.background.start handler", () => {
  const validOutput = { taskId: "task_1", inngestRunId: "inngest_run_1" };

  it("exports schema and metadata", () => {
    expect(agentTaskBackgroundStartSchema).toBeDefined();
    expect(agentTaskBackgroundStartMetadata.name).toBe("start_background_task");
  });

  it("calls invoke with start args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { kind: "agent.run", payload: { foo: 1 }, label: undefined };
    const result = await handler_agentTaskBackgroundStart(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "start_background_task",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({
      taskId: "task_1",
      inngestRunId: "inngest_run_1",
    });
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

// ── agent.subagent.fanout.list ────────────────────────────────────────────────

import handler_agentSubagentFanoutList, {
  schema as agentSubagentFanoutListSchema,
  metadata as agentSubagentFanoutListMetadata,
} from "./agent.subagent_fanout.list";

describe("agent.subagent.fanout.list handler", () => {
  it("exports schema and metadata", () => {
    expect(agentSubagentFanoutListSchema).toBeDefined();
    expect(agentSubagentFanoutListMetadata.name).toBe("list_subagent_fanouts");
    expect(agentSubagentFanoutListMetadata.annotations?.readOnlyHint).toBe(
      true,
    );
  });

  it("forwards to invoke and parses the output", async () => {
    mocks.invoke.mockResolvedValue({ fanouts: [] });
    const args = { limit: 50 };
    const result = await handler_agentSubagentFanoutList(args as never);
    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_subagent_fanouts",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result.fanouts).toEqual([]);
  });

  it("propagates invoke errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("invoke failed"));
    await expect(
      handler_agentSubagentFanoutList({ limit: 50 } as never),
    ).rejects.toThrow("invoke failed");
  });
});

// ── agent.subagent.fanout.get ─────────────────────────────────────────────────

import handler_agentSubagentFanoutGet, {
  schema as agentSubagentFanoutGetSchema,
  metadata as agentSubagentFanoutGetMetadata,
} from "./agent.subagent_fanout.get";

describe("agent.subagent.fanout.get handler", () => {
  const validOutput = {
    fanoutId: "fan_1",
    parentMessageId: "msg_1",
    status: "completed" as const,
    totalChildren: 1,
    completedChildren: 1,
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:01:00.000Z",
    runs: [],
  };

  it("exports schema and metadata", () => {
    expect(agentSubagentFanoutGetSchema).toBeDefined();
    expect(agentSubagentFanoutGetMetadata.name).toBe("get_subagent_fanout");
  });

  it("forwards fanoutId to invoke and parses the output", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { fanoutId: "fan_1" };
    const result = await handler_agentSubagentFanoutGet(args as never);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_subagent_fanout",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result.fanoutId).toBe("fan_1");
  });
});
