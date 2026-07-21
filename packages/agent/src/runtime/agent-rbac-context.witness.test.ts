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

const agentPrincipal = {
  id: "00000000-0000-0000-0000-0000000000a1",
  kind: "agent" as const,
  orgId: "org-1",
  workspaceId: "ws-1",
};
const humanPrincipal = {
  id: "00000000-0000-0000-0000-0000000000b1",
  kind: "human" as const,
  orgId: "org-1",
  workspaceId: "ws-1",
};

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

it("threads the persistent agent principal and invoking human principal into a durable agent run", async () => {
  const run: ClaimedRun & {
    agentPrincipal: typeof agentPrincipal;
    humanPrincipal: typeof humanPrincipal;
  } = {
    runId: "run-1",
    publicId: "arun-1",
    orgId: "org-1",
    workspaceId: "ws-1",
    surface: "api-chat",
    spec: { version: 1, instruction: "help" },
    attempts: 1,
    checkpoint: null,
    checkpointSeq: 0,
    agentPrincipal,
    humanPrincipal,
  };

  await createPlatformTurnDriver()(run, {
    onEvent: () => undefined,
    checkpoint: async () => undefined,
    signal: new AbortController().signal,
  });

  expect(mocks.materializeTools).toHaveBeenCalledWith(
    expect.objectContaining({
      principalKind: "agent",
      agentPrincipal,
      humanPrincipal,
    }),
    expect.anything(),
  );
});
