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

// xmcp passes a second `extra` argument; type matches any handler signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeExtra: any = {};

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
    expect(agentApprovalResolveMetadata.name).toBe("agent.approval.resolve");
  });

  it("calls buildContext then invoke with correct contract name and args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { approvalId: "apr_1", decision: "approved" as const };
    const result = await handler_agentApprovalResolve(args, fakeExtra);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent.approval.resolve",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({ approvalId: "apr_1", resolution: "approved" });
  });

  it("propagates invoke errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("invoke failed"));
    await expect(
      handler_agentApprovalResolve({ approvalId: "x", decision: "denied" }, fakeExtra),
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
    expect(agentMcpListMetadata.name).toBe("agent.mcp.list");
  });

  it("calls invoke with 'agent.mcp.list' and empty args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const result = await handler_agentMcpList({}, fakeExtra);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent.mcp.list",
      {},
      fakeCtx,
      { surface: "mcp" },
    );
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
    expect(agentMcpRegisterMetadata.name).toBe("agent.mcp.register");
  });

  it("calls invoke with correct args and forwards result", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = {
      name: "Test MCP",
      transportType: "streamable-http" as const,
      endpointUrl: "https://mcp.example.com/mcp",
      authStrategy: "none" as const,
    };
    const result = await handler_agentMcpRegister(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent.mcp.register",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({ mcpServerId: "srv_1", healthStatus: "healthy" });
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
    expect(agentMemoryRecallMetadata.name).toBe("agent.memory.recall");
  });

  it("calls invoke with recall args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { query: "user prefs", minWeight: "high" as const, limit: 10 };
    await handler_agentMemoryRecall(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent.memory.recall",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── agent.memory.write ────────────────────────────────────────────────────────

import handler_agentMemoryWrite, {
  schema as agentMemoryWriteSchema,
  metadata as agentMemoryWriteMetadata,
} from "./agent.memory.write";

describe("agent.memory.write handler", () => {
  const validOutput = { memoryId: "mem_1", nodeRef: "node-abc" };

  it("exports schema and metadata", () => {
    expect(agentMemoryWriteSchema).toBeDefined();
    expect(agentMemoryWriteMetadata.name).toBe("agent.memory.write");
  });

  it("calls invoke with write args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = {
      nodeRef: "node-abc",
      weight: "high" as const,
      kind: "gotcha" as const,
      lesson: "Always flush cache",
      source: "fix" as const,
    };
    const result = await handler_agentMemoryWrite(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent.memory.write",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
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
    expect(agentPlanApproveMetadata.name).toBe("agent.plan.approve");
  });

  it("calls invoke with plan approval args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { planId: "plan_1", decision: "approve" as const };
    await handler_agentPlanApprove(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent.plan.approve",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
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
    expect(agentSkillListMetadata.name).toBe("agent.skill.list");
  });

  it("calls invoke with skill list args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { filter: "my-skill" };
    await handler_agentSkillList(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent.skill.list",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });

  it("works with empty args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    await handler_agentSkillList({}, fakeExtra);
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });
});

// ── agent.task.background.cancel ─────────────────────────────────────────────

import handler_agentTaskBackgroundCancel, {
  schema as agentTaskBackgroundCancelSchema,
  metadata as agentTaskBackgroundCancelMetadata,
} from "./agent.task.background.cancel";

describe("agent.task.background.cancel handler", () => {
  const validOutput = { taskId: "task_1", status: "cancelled" as const };

  it("exports schema and metadata", () => {
    expect(agentTaskBackgroundCancelSchema).toBeDefined();
    expect(agentTaskBackgroundCancelMetadata.name).toBe("agent.task.background.cancel");
  });

  it("calls invoke with cancel args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { taskId: "task_1" };
    await handler_agentTaskBackgroundCancel(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent.task.background.cancel",
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
} from "./agent.task.background.read";

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
    expect(agentTaskBackgroundReadMetadata.name).toBe("agent.task.background.read");
  });

  it("calls invoke with read args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { taskId: "task_1" };
    const result = await handler_agentTaskBackgroundRead(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent.task.background.read",
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
} from "./agent.task.background.start";

describe("agent.task.background.start handler", () => {
  const validOutput = { taskId: "task_1", inngestRunId: "inngest_run_1" };

  it("exports schema and metadata", () => {
    expect(agentTaskBackgroundStartSchema).toBeDefined();
    expect(agentTaskBackgroundStartMetadata.name).toBe("agent.task.background.start");
  });

  it("calls invoke with start args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { kind: "agent.run", payload: { foo: 1 } };
    const result = await handler_agentTaskBackgroundStart(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent.task.background.start",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({ taskId: "task_1", inngestRunId: "inngest_run_1" });
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
    expect(agentToolListMetadata.name).toBe("agent.tool.list");
  });

  it("calls invoke with tool list args", async () => {
    mocks.invoke.mockResolvedValue(validOutput);
    const args = { includeExternal: true };
    await handler_agentToolList(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent.tool.list",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});
