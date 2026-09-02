import { describe, expect, it, vi, beforeEach } from "vitest";

const insertSpy = vi.fn();
const returningValues = {
  publicId: "pln_test01",
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
};

const fakeInsertChain = {
  values: vi.fn().mockReturnThis(),
  returning: vi.fn().mockResolvedValue([returningValues]),
};

const fakeDb = {
  insert: vi.fn().mockReturnValue(fakeInsertChain),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) =>
      fn(fakeDb),
  };
});

insertSpy.mockReturnValue(fakeInsertChain);

import { agentPlanCreateHandler } from "./agent.plan.create";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

const BASIC_INPUT = {
  goals: ["Build a REST API", "Add authentication"],
  constraints: ["No external databases"],
  tasks: [
    { id: "t1", title: "Design schema", dependsOn: [] },
    { id: "t2", title: "Implement routes", dependsOn: ["t1"] },
    {
      id: "t3",
      title: "Add auth middleware",
      dependsOn: ["t1"],
      parentTaskId: null,
    },
  ],
  approvalRequired: true,
};

describe("agent.plan.create handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeInsertChain.values.mockReturnThis();
    fakeInsertChain.returning.mockResolvedValue([returningValues]);
    fakeDb.insert.mockReturnValue(fakeInsertChain);
  });

  it("inserts a plan and returns planId + status", async () => {
    const result = await agentPlanCreateHandler(BASIC_INPUT, CTX);
    expect(result.planId).toBe("pln_test01");
    expect(result.status).toBe("awaiting_approval");
    expect(result.goals).toEqual(BASIC_INPUT.goals);
    expect(result.tasks).toHaveLength(3);
    expect(result.approvalRequired).toBe(true);
  });

  it("sets status to draft when approvalRequired is false", async () => {
    const result = await agentPlanCreateHandler(
      { ...BASIC_INPUT, approvalRequired: false },
      CTX,
    );
    expect(result.status).toBe("draft");
  });

  it("rejects tasks with unknown dependsOn references", async () => {
    const badInput = {
      ...BASIC_INPUT,
      tasks: [{ id: "t1", title: "Task 1", dependsOn: ["nonexistent"] }],
    };
    await expect(agentPlanCreateHandler(badInput, CTX)).rejects.toThrow(
      'Task "t1" depends on unknown task "nonexistent"',
    );
  });

  it("rejects tasks with unknown parentTaskId", async () => {
    const badInput = {
      ...BASIC_INPUT,
      tasks: [
        {
          id: "t1",
          title: "Task 1",
          dependsOn: [],
          parentTaskId: "ghost_parent",
        },
      ],
    };
    await expect(agentPlanCreateHandler(badInput, CTX)).rejects.toThrow(
      'Task "t1" references unknown parent "ghost_parent"',
    );
  });

  it("rejects plans with more than 100 tasks", async () => {
    const tooManyTasks = Array.from({ length: 101 }, (_, i) => ({
      id: `t${i}`,
      title: `Task ${i}`,
      dependsOn: [],
    }));
    await expect(
      agentPlanCreateHandler({ ...BASIC_INPUT, tasks: tooManyTasks }, CTX),
    ).rejects.toThrow("Plans are limited to 100 tasks");
  });

  it("throws when db insert returns no rows", async () => {
    fakeInsertChain.returning.mockResolvedValueOnce([]);
    await expect(agentPlanCreateHandler(BASIC_INPUT, CTX)).rejects.toThrow(
      "agent_plans insert failed",
    );
  });

  it("passes messageId to the insert when provided", async () => {
    await agentPlanCreateHandler({ ...BASIC_INPUT, messageId: "msg_abc" }, CTX);
    const valuesArg = fakeInsertChain.values.mock.calls[0]?.[0] as {
      messageId: string;
    };
    expect(valuesArg.messageId).toBe("msg_abc");
  });
});
