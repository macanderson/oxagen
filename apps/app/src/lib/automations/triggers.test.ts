/**
 * triggers.test.ts — unit tests for the agent.trigger.* / agent.definition.list
 * invoke() wrappers and the workspace-wide trigger fan-out (listWorkspaceTriggers).
 *
 * Mock seam: @oxagen/oxagen → invoke, each contract module (passthrough
 * parse), and ./scope → resolveAutomationsScope. Verifies each ctx-based
 * helper dispatches the right capability name with the right input shape and
 * omits opts.surface (kernel surface gate stays skipped, ctx.surface="app" is
 * the honest surface) — same discipline as automations.test.ts. Also verifies
 * the fan-out assembles rows across agents and tolerates a rejected per-agent
 * list_triggers call without dropping the rest of the board.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen", () => ({ invoke: vi.fn() }));

// vi.hoisted so `passthrough` is initialized before the hoisted vi.mock
// factories below reference it (plain const would be in its TDZ at mock time).
const { passthrough } = vi.hoisted(() => ({
  passthrough: (name: string) => ({
    [name]: {
      name,
      input: { parse: (v: unknown) => v },
      output: { parse: (v: unknown) => v },
    },
  }),
}));
vi.mock("@oxagen/oxagen/contracts/agent.trigger.list", () => ({
  agentTriggerList: passthrough("list_triggers").list_triggers,
}));
vi.mock("@oxagen/oxagen/contracts/agent.trigger.create", () => ({
  agentTriggerCreate: passthrough("create_trigger").create_trigger,
}));
vi.mock("@oxagen/oxagen/contracts/agent.trigger.update", () => ({
  agentTriggerUpdate: passthrough("update_trigger").update_trigger,
}));
vi.mock("@oxagen/oxagen/contracts/agent.trigger.delete", () => ({
  agentTriggerDelete: passthrough("delete_trigger").delete_trigger,
}));
vi.mock("@oxagen/oxagen/contracts/agent.definition.list", () => ({
  agentDefinitionList: passthrough("list_agent_defs").list_agent_defs,
}));

const mockResolveAutomationsScope = vi.fn();
vi.mock("./scope", () => ({
  resolveAutomationsScope: (...args: unknown[]) => mockResolveAutomationsScope(...args),
}));

import { invoke } from "@oxagen/oxagen";
import {
  listAgentDefs,
  listAgentOptions,
  listTriggers,
  createTrigger,
  updateTrigger,
  deleteTrigger,
  listWorkspaceTriggers,
  describeBinding,
} from "./triggers";
import type { AutomationsCtx } from "./scope";

const mockInvoke = vi.mocked(invoke);

const CTX: AutomationsCtx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app",
  messageId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agent.trigger.* / agent.definition.list helpers", () => {
  it("listAgentDefs dispatches list_agent_defs with no filter, no opts", async () => {
    mockInvoke.mockResolvedValue({ agents: [] });
    await listAgentDefs(CTX);
    expect(mockInvoke).toHaveBeenCalledWith("list_agent_defs", {}, CTX);
    expect(mockInvoke.mock.calls[0]).toHaveLength(3);
  });

  it("listAgentOptions filters out product-managed agents", async () => {
    mockInvoke.mockResolvedValue({
      agents: [
        { agentId: "a1", publicId: "agt_1", name: "Agent One", agentType: "custom", managed: false },
        { agentId: "a2", publicId: "agt_2", name: "Built-in", agentType: "custom", managed: true },
      ],
    });
    const options = await listAgentOptions(CTX);
    expect(options).toEqual([
      { agentId: "a1", publicId: "agt_1", name: "Agent One", agentType: "custom" },
    ]);
  });

  it("listTriggers dispatches list_triggers scoped to the agent, no opts", async () => {
    mockInvoke.mockResolvedValue({ triggers: [] });
    await listTriggers(CTX, "a1");
    expect(mockInvoke).toHaveBeenCalledWith("list_triggers", { agentId: "a1" }, CTX);
    expect(mockInvoke.mock.calls[0]).toHaveLength(3);
  });

  it("createTrigger dispatches create_trigger with agentId + trigger, no opts", async () => {
    mockInvoke.mockResolvedValue({});
    const trigger = { type: "manual" as const, enabled: true };
    await createTrigger(CTX, "a1", trigger);
    expect(mockInvoke).toHaveBeenCalledWith("create_trigger", { agentId: "a1", trigger }, CTX);
    expect(mockInvoke.mock.calls[0]).toHaveLength(3);
  });

  it("updateTrigger dispatches update_trigger with triggerId + trigger, no opts", async () => {
    mockInvoke.mockResolvedValue({});
    const trigger = { type: "schedule" as const, schedule: "0 9 * * 1", enabled: false };
    await updateTrigger(CTX, "atr_1", trigger);
    expect(mockInvoke).toHaveBeenCalledWith("update_trigger", { triggerId: "atr_1", trigger }, CTX);
    expect(mockInvoke.mock.calls[0]).toHaveLength(3);
  });

  it("deleteTrigger dispatches delete_trigger with the id, no opts", async () => {
    mockInvoke.mockResolvedValue({});
    await deleteTrigger(CTX, "atr_2");
    expect(mockInvoke).toHaveBeenCalledWith("delete_trigger", { triggerId: "atr_2" }, CTX);
    expect(mockInvoke.mock.calls[0]).toHaveLength(3);
  });
});

describe("describeBinding", () => {
  it("describes a manual trigger", () => {
    expect(
      describeBinding({
        triggerType: "manual",
        schedule: null,
        eventSource: null,
        eventType: null,
        filter: {},
      }),
    ).toBe("Manual — run on demand");
  });

  it("describes a schedule trigger with its cron string", () => {
    expect(
      describeBinding({
        triggerType: "schedule",
        schedule: "0 9 * * 1",
        eventSource: null,
        eventType: null,
        filter: {},
      }),
    ).toBe("cron 0 9 * * 1");
  });

  it("flags a missing cron on a schedule trigger", () => {
    expect(
      describeBinding({
        triggerType: "schedule",
        schedule: null,
        eventSource: null,
        eventType: null,
        filter: {},
      }),
    ).toBe("No cron set");
  });

  it("describes an event trigger and flags a non-empty filter", () => {
    expect(
      describeBinding({
        triggerType: "event",
        schedule: null,
        eventSource: "github_repo",
        eventType: "push",
        filter: { branches: ["main"] },
      }),
    ).toBe("github_repo / push (filtered)");

    expect(
      describeBinding({
        triggerType: "event",
        schedule: null,
        eventSource: "github_repo",
        eventType: "push",
        filter: {},
      }),
    ).toBe("github_repo / push");
  });
});

describe("listWorkspaceTriggers (workspace-wide fan-out)", () => {
  it("resolves scope internally and assembles rows across agents", async () => {
    mockResolveAutomationsScope.mockResolvedValue({ ctx: CTX, canManage: true });
    mockInvoke.mockImplementation(async (name: unknown, input: unknown) => {
      if (name === "list_agent_defs") {
        return {
          agents: [
            { agentId: "a1", publicId: "agt_1", name: "Agent One", agentType: "custom", managed: false },
            { agentId: "a2", publicId: "agt_2", name: "Agent Two", agentType: "custom", managed: false },
          ],
        };
      }
      if (name === "list_triggers") {
        const agentId = (input as { agentId: string }).agentId;
        if (agentId === "a1") {
          return {
            triggers: [
              {
                triggerId: "uuid-1",
                publicId: "atr_1",
                triggerType: "manual",
                eventSource: null,
                eventType: null,
                connectionId: null,
                filter: {},
                schedule: null,
                enabled: true,
              },
            ],
          };
        }
        return { triggers: [] };
      }
      throw new Error(`unexpected invoke ${String(name)}`);
    });

    const result = await listWorkspaceTriggers("acme", "default");
    expect(mockResolveAutomationsScope).toHaveBeenCalledWith("acme", "default");
    expect(result.canManage).toBe(true);
    expect(result.failedAgents).toBe(0);
    expect(result.rows).toEqual([
      {
        agentId: "a1",
        agentPublicId: "agt_1",
        agentName: "Agent One",
        triggerId: "atr_1",
        triggerType: "manual",
        bindingSummary: "Manual — run on demand",
        enabled: true,
        schedule: null,
        eventSource: null,
        eventType: null,
        connectionId: null,
        filter: {},
      },
    ]);
  });

  it("tolerates a rejected per-agent list_triggers call — keeps the rest, counts failedAgents", async () => {
    mockResolveAutomationsScope.mockResolvedValue({ ctx: CTX, canManage: false });
    mockInvoke.mockImplementation(async (name: unknown, input: unknown) => {
      if (name === "list_agent_defs") {
        return {
          agents: [
            { agentId: "a1", publicId: "agt_1", name: "Agent One", agentType: "custom", managed: false },
            { agentId: "a2", publicId: "agt_2", name: "Agent Two", agentType: "custom", managed: false },
          ],
        };
      }
      if (name === "list_triggers") {
        const agentId = (input as { agentId: string }).agentId;
        if (agentId === "a2") throw new Error("agent unreachable");
        return {
          triggers: [
            {
              triggerId: "uuid-1",
              publicId: "atr_1",
              triggerType: "schedule",
              eventSource: null,
              eventType: null,
              connectionId: null,
              filter: {},
              schedule: "0 9 * * 1",
              enabled: false,
            },
          ],
        };
      }
      throw new Error(`unexpected invoke ${String(name)}`);
    });

    const result = await listWorkspaceTriggers("acme", "default");
    expect(result.failedAgents).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.agentId).toBe("a1");
    expect(result.canManage).toBe(false);
  });

  it("propagates a whole-fan-out failure (list_agent_defs itself rejects)", async () => {
    mockResolveAutomationsScope.mockResolvedValue({ ctx: CTX, canManage: true });
    mockInvoke.mockRejectedValue(new Error("boom"));
    await expect(listWorkspaceTriggers("acme", "default")).rejects.toThrow("boom");
  });
});
