/**
 * automations.test.ts — unit tests for the automation.* invoke() wrappers.
 *
 * Mock seam: @oxagen/oxagen → invoke, plus each contract module (passthrough
 * parse). Verifies each helper dispatches the right capability name with the
 * right input shape, threads ctx, and — critically — omits opts.surface (so the
 * kernel surface gate is skipped and ctx.surface="app" is the surface used).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen", () => ({ invoke: vi.fn() }));

// vi.hoisted so the hoisted vi.mock factories below can reference it without a
// temporal-dead-zone error (vi.mock calls are lifted above plain const decls).
const passthrough = vi.hoisted(() => (name: string) => ({
  [name]: {
    name,
    input: { parse: (v: unknown) => v },
    output: { parse: (v: unknown) => v },
  },
}));
vi.mock("@oxagen/oxagen/contracts/automation.list", () => ({
  automationList: passthrough("list_automations").list_automations,
}));
vi.mock("@oxagen/oxagen/contracts/automation.get", () => ({
  automationGet: passthrough("get_automation").get_automation,
}));
vi.mock("@oxagen/oxagen/contracts/automation.create", () => ({
  automationCreate: passthrough("create_automation").create_automation,
}));
vi.mock("@oxagen/oxagen/contracts/automation.enable", () => ({
  automationEnable: passthrough("enable_automation").enable_automation,
}));
vi.mock("@oxagen/oxagen/contracts/automation.disable", () => ({
  automationDisable: passthrough("disable_automation").disable_automation,
}));
vi.mock("@oxagen/oxagen/contracts/automation.trigger", () => ({
  automationTrigger: passthrough("trigger_automation").trigger_automation,
}));
vi.mock("@oxagen/oxagen/contracts/automation.update", () => ({
  automationUpdate: passthrough("update_automation").update_automation,
}));

import { invoke } from "@oxagen/oxagen";
import {
  listAutomations,
  getAutomation,
  createAutomation,
  enableAutomation,
  disableAutomation,
  triggerAutomation,
  updateAutomation,
} from "./automations";
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

describe("automation.* helpers", () => {
  it("listAutomations dispatches list_automations scoped to the workspace, no opts", async () => {
    mockInvoke.mockResolvedValue([]);
    await listAutomations(CTX);
    expect(mockInvoke).toHaveBeenCalledWith(
      "list_automations",
      { workspace_id: "ws-1" },
      CTX,
    );
  });

  it("getAutomation dispatches get_automation with the id, no opts", async () => {
    mockInvoke.mockResolvedValue({});
    await getAutomation(CTX, "plt_9");
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_automation",
      { automation_id: "plt_9" },
      CTX,
    );
  });

  it("createAutomation dispatches create_automation with the given input", async () => {
    mockInvoke.mockResolvedValue({});
    const input = {
      name: "n",
      triggerType: "api" as const,
      triggerConfig: {},
      steps: [],
      enabled: false,
    };
    await createAutomation(CTX, input as never);
    expect(mockInvoke).toHaveBeenCalledWith("create_automation", input, CTX);
  });

  it("enableAutomation dispatches enable_automation with the id, no opts", async () => {
    mockInvoke.mockResolvedValue({});
    await enableAutomation(CTX, "plt_1");
    expect(mockInvoke).toHaveBeenCalledWith(
      "enable_automation",
      { automation_id: "plt_1" },
      CTX,
    );
  });

  it("disableAutomation dispatches disable_automation with the id", async () => {
    mockInvoke.mockResolvedValue({});
    await disableAutomation(CTX, "plt_2");
    expect(mockInvoke).toHaveBeenCalledWith(
      "disable_automation",
      { automation_id: "plt_2" },
      CTX,
    );
  });

  it("triggerAutomation forwards the optional payload", async () => {
    mockInvoke.mockResolvedValue({});
    await triggerAutomation(CTX, "plt_3", { reason: "test" });
    expect(mockInvoke).toHaveBeenCalledWith(
      "trigger_automation",
      { automation_id: "plt_3", payload: { reason: "test" } },
      CTX,
    );
  });

  it("updateAutomation dispatches update_automation with the given input", async () => {
    mockInvoke.mockResolvedValue({});
    const input = { automation_id: "plt_4", name: "renamed" };
    await updateAutomation(CTX, input as never);
    expect(mockInvoke).toHaveBeenCalledWith("update_automation", input, CTX);
  });

  it("never passes an opts.surface override (kernel gate stays skipped)", async () => {
    mockInvoke.mockResolvedValue([]);
    await listAutomations(CTX);
    // exactly three args — a fourth (opts) would flip on the surface allowlist gate.
    expect(mockInvoke.mock.calls[0]).toHaveLength(3);
  });
});
