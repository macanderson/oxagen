import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  materializeTools: vi.fn(),
  createPlatformAgentAi: vi.fn(),
  createPlatformMemoryProvider: vi.fn(),
  executeTurn: vi.fn(),
  invoke: vi.fn(),
  createTurnBudgetGuard: vi.fn(),
}));

vi.mock("./materialize-tools", () => ({
  materializeTools: mocks.materializeTools,
}));
vi.mock("../adapters", () => ({
  createPlatformAgentAi: mocks.createPlatformAgentAi,
  createPlatformMemoryProvider: mocks.createPlatformMemoryProvider,
}));
vi.mock("@oxagen/agent-runner", () => ({
  executeTurn: mocks.executeTurn,
  DEFAULT_AGENT_MODEL: "test-model",
  DEFAULT_MAX_AGENT_STEPS: 8,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("@oxagen/billing", async () => {
  const actual =
    await vi.importActual<typeof import("@oxagen/billing")>("@oxagen/billing");
  return { ...actual, createTurnBudgetGuard: mocks.createTurnBudgetGuard };
});

import { createPlatformTurnDriver, type ClaimedRun } from "./turn-driver";

beforeEach(() => {
  mocks.materializeTools.mockResolvedValue({
    tools: {},
    nameMap: {},
    mutatingToolNames: [],
  });
  mocks.createPlatformAgentAi.mockReturnValue({});
  mocks.createPlatformMemoryProvider.mockReturnValue({});
  mocks.invoke.mockResolvedValue({
    enabled: false,
    limitUsd: null,
    mode: "enforce",
    graceOveragePct: 0.25,
    enforcement: "ceiling",
  });
  mocks.createTurnBudgetGuard.mockReturnValue(undefined);
  mocks.executeTurn.mockResolvedValue({
    text: "done",
    steps: 1,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
});

it("rejects an agent run whose invoking principal is not human", async () => {
  const malformedClaim = {
    runId: "run-1",
    publicId: "arun-1",
    orgId: "org-1",
    workspaceId: "ws-1",
    surface: "api-chat",
    spec: { version: 1, instruction: "help" },
    attempts: 1,
    checkpoint: null,
    checkpointSeq: 0,
    agentPrincipal: {
      id: "00000000-0000-0000-0000-0000000000a1",
      kind: "agent",
      orgId: "org-1",
      workspaceId: "ws-1",
    },
    humanPrincipal: {
      id: "00000000-0000-0000-0000-0000000000b1",
      kind: "agent",
      orgId: "org-1",
      workspaceId: "ws-1",
    },
  } as ClaimedRun;

  await expect(
    createPlatformTurnDriver()(malformedClaim, {
      onEvent: () => undefined,
      checkpoint: async () => undefined,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/human principal.*kind.*human/i);
});
