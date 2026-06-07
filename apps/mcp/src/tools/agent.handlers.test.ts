// agent.handlers.test.ts — handler invocation tests for all agent-domain tools.
//
// Pattern: vi.mock the kernel `invoke` and the context seam `buildContext` so
// that each default-export handler can be called without a live runtime.
// Each test asserts: (a) buildContext was called, (b) invoke was called once
// with the correct contract name + args + { surface: "mcp" }, (c) the handler
// returns/forwards the invoke result.
//
// Schema-boundary (valid/invalid parse) tests live in agent.schema.test.ts.

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

const fakeExtra = {} as Parameters<typeof import("./agent.approval.resolve")["default"]>[1];

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
  it("exports schema and metadata", () => {
    expect(agentApprovalResolveSchema).toBeDefined();
    expect(agentApprovalResolveMetadata.name).toBe("agent.approval.resolve");
  });

  it("calls buildContext then invoke with correct args", async () => {
    const fakeOutput = { approvalId: "apr_1", resolution: "approved" };
    mocks.invoke.mockResolvedValue(fakeOutput);

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
  it("exports schema and metadata", () => {
    expect(agentMcpListSchema).toBeDefined();
    expect(agentMcpListMetadata.name).toBe("agent.mcp.list");
  });

  it("calls invoke with 'agent.mcp.list' and empty args", async () => {
    const fakeOutput = { servers: [] };
    mocks.invoke.mockResolvedValue(fakeOutput);

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
  it("exports schema and metadata", () => {
    expect(agentMcpRegisterSchema).toBeDefined();
    expect(agentMcpRegisterMetadata.name).toBe("agent.mcp.register");
  });

  it("calls invoke with correct args", async () => {
    const fakeOutput = { serverId: "srv_1", name: "Test Server" };
    mocks.invoke.mockResolvedValue(fakeOutput);

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
    expect(result).toMatchObject({ serverId: "srv_1" });
  });
});

// ── agent.memory.recall ───────────────────────────────────────────────────────

import handler_agentMemoryRecall, {
  schema as agentMemoryRecallSchema,
  metadata as agentMemoryRecallMetadata,
} from "./agent.memory.recall";

describe("agent.memory.recall handler", () => {
  it("exports schema and metadata", () => {
    expect(agentMemoryRecallSchema).toBeDefined();
    expect(agentMemoryRecallMetadata.name).toBe("agent.memory.recall");
  });

  it("calls invoke with recall args", async () => {
    const fakeOutput = { nodes: [] };
    mocks.invoke.mockResolvedValue(fakeOutput);

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
  it("exports schema and metadata", () => {
    expect(agentMemoryWriteSchema).toBeDefined();
    expect(agentMemoryWriteMetadata.name).toBe("agent.memory.write");
  });

  it("calls invoke with write args", async () => {
    const fakeOutput = { nodeId: "node_1" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      nodeRef: "node-abc",
      weight: "high" as const,
      kind: "gotcha" as const,
      lesson: "Always flush cache",
      source: "fix" as const,
    };
    await handler_agentMemoryWrite(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent.memory.write",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── agent.plan.approve ────────────────────────────────────────────────────────

import handler_agentPlanApprove, {
  schema as agentPlanApproveSchema,
  metadata as agentPlanApproveMetadata,
} from "./agent.plan.approve";

describe("agent.plan.approve handler", () => {
  it("exports schema and metadata", () => {
    expect(agentPlanApproveSchema).toBeDefined();
    expect(agentPlanApproveMetadata.name).toBe("agent.plan.approve");
  });

  it("calls invoke with plan approval args", async () => {
    const fakeOutput = { planId: "plan_1", status: "approved" };
    mocks.invoke.mockResolvedValue(fakeOutput);

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
  it("exports schema and metadata", () => {
    expect(agentSkillListSchema).toBeDefined();
    expect(agentSkillListMetadata.name).toBe("agent.skill.list");
  });

  it("calls invoke with skill list args", async () => {
    const fakeOutput = { skills: [] };
    mocks.invoke.mockResolvedValue(fakeOutput);

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
    mocks.invoke.mockResolvedValue({ skills: [] });
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
  it("exports schema and metadata", () => {
    expect(agentTaskBackgroundCancelSchema).toBeDefined();
    expect(agentTaskBackgroundCancelMetadata.name).toBe("agent.task.background.cancel");
  });

  it("calls invoke with cancel args", async () => {
    const fakeOutput = { taskId: "task_1", status: "cancelled" };
    mocks.invoke.mockResolvedValue(fakeOutput);

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
  it("exports schema and metadata", () => {
    expect(agentTaskBackgroundReadSchema).toBeDefined();
    expect(agentTaskBackgroundReadMetadata.name).toBe("agent.task.background.read");
  });

  it("calls invoke with read args", async () => {
    const fakeOutput = {
      taskId: "task_1",
      kind: "agent.run",
      status: "completed",
      label: null,
      resultPayload: null,
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { taskId: "task_1" };
    await handler_agentTaskBackgroundRead(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent.task.background.read",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── agent.task.background.start ───────────────────────────────────────────────

import handler_agentTaskBackgroundStart, {
  schema as agentTaskBackgroundStartSchema,
  metadata as agentTaskBackgroundStartMetadata,
} from "./agent.task.background.start";

describe("agent.task.background.start handler", () => {
  it("exports schema and metadata", () => {
    expect(agentTaskBackgroundStartSchema).toBeDefined();
    expect(agentTaskBackgroundStartMetadata.name).toBe("agent.task.background.start");
  });

  it("calls invoke with start args", async () => {
    const fakeOutput = { taskId: "task_1", status: "pending" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { kind: "agent.run", payload: { foo: 1 } };
    await handler_agentTaskBackgroundStart(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "agent.task.background.start",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── agent.tool.list ───────────────────────────────────────────────────────────

import handler_agentToolList, {
  schema as agentToolListSchema,
  metadata as agentToolListMetadata,
} from "./agent.tool.list";

describe("agent.tool.list handler", () => {
  it("exports schema and metadata", () => {
    expect(agentToolListSchema).toBeDefined();
    expect(agentToolListMetadata.name).toBe("agent.tool.list");
  });

  it("calls invoke with tool list args", async () => {
    const fakeOutput = { tools: [] };
    mocks.invoke.mockResolvedValue(fakeOutput);

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
