import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import tool, { metadata } from "./privacy.data.export.status";

const exportId = "550e8400-e29b-41d4-a716-446655440000";
const context = {
  userId: "11111111-1111-4111-8111-111111111111",
  surface: "mcp",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(context);
});

describe("get_export_status MCP", () => {
  it("uses the authenticated user context and validates the kernel answer", async () => {
    const result = {
      exportId,
      status: "ready",
      ready: true,
      storageKey: "privacy/export.zip",
      completedAt: null,
    };
    mocks.invoke.mockResolvedValue(result);
    expect(metadata.name).toBe("get_export_status");
    expect(await tool({ exportId })).toEqual(result);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_export_status",
      { exportId },
      context,
      { surface: "mcp" },
    );
  });
  it("preserves the handler refusal for a machine without a user", async () => {
    const machine = { ...context, userId: null };
    const error = new Error("no_principal");
    mocks.buildContext.mockResolvedValue(machine);
    mocks.invoke.mockRejectedValue(error);
    await expect(tool({ exportId })).rejects.toBe(error);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_export_status",
      { exportId },
      machine,
      { surface: "mcp" },
    );
  });
  it("rejects a malformed kernel answer", async () => {
    mocks.invoke.mockResolvedValue({ exportId });
    await expect(tool({ exportId })).rejects.toThrow();
  });
});
