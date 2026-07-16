/**
 * code-mode-data.test.ts — characterization tests for the chat composer's
 * code-mode picker loader: repo parsing from deliveryConfig, the bounded
 * connection.get fan-out (CODE_MODE_CONNECTION_LIMIT), and the never-throws
 * degradation contract.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  runInTenantScope: vi.fn(),
  connectionListHandler: vi.fn(),
  connectionGetHandler: vi.fn(),
  environmentListHandler: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));
vi.mock("@oxagen/handlers/connection.list", () => ({
  connectionListHandler: mocks.connectionListHandler,
}));
vi.mock("@oxagen/handlers/connection.get", () => ({
  connectionGetHandler: mocks.connectionGetHandler,
}));
vi.mock("@oxagen/handlers/environment.list", () => ({
  environmentListHandler: mocks.environmentListHandler,
}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { warn: mocks.warn, error: vi.fn(), info: vi.fn() },
}));

import { loadCodeModeOptions } from "./code-mode-data";
import type { CapabilityContext } from "@oxagen/oxagen";

const ctx = { orgId: "org-1", workspaceId: "ws-1" } as unknown as CapabilityContext;

function connection(publicId: string, status = "connected") {
  return { publicId, status };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
  mocks.environmentListHandler.mockResolvedValue({ environments: [] });
});

describe("loadCodeModeOptions", () => {
  it("maps connected connections' deliveryConfig into repo options", async () => {
    mocks.connectionListHandler.mockResolvedValue({
      connections: [connection("con-1"), connection("con-2", "pending_setup")],
    });
    mocks.connectionGetHandler.mockResolvedValue({
      deliveryConfig: { owner: "oxagen", repo: "platform", defaultBranch: "main" },
    });

    const result = await loadCodeModeOptions("org-1", "ws-1", ctx);

    // Only the connected connection is enriched; pending_setup is excluded.
    expect(mocks.connectionGetHandler).toHaveBeenCalledTimes(1);
    expect(result.repos).toEqual([
      {
        key: "con-1::oxagen/platform",
        connectionId: "con-1",
        owner: "oxagen",
        name: "platform",
        defaultBranch: "main",
      },
    ]);
  });

  it("bounds the connection.get fan-out to the connection limit and warns", async () => {
    const many = Array.from({ length: 14 }, (_, i) => connection(`con-${i}`));
    mocks.connectionListHandler.mockResolvedValue({ connections: many });
    mocks.connectionGetHandler.mockResolvedValue({
      deliveryConfig: { owner: "o", repo: "r", defaultBranch: null },
    });

    const result = await loadCodeModeOptions("org-1", "ws-1", ctx);

    // Capped at 10 (CODE_MODE_CONNECTION_LIMIT), never one call per connection.
    expect(mocks.connectionGetHandler).toHaveBeenCalledTimes(10);
    expect(result.repos).toHaveLength(10);
    // No silent caps: the truncation is logged.
    expect(
      mocks.warn.mock.calls.some((c) => String(c[1]).includes("truncated")),
    ).toBe(true);
  });

  it("degrades a failed connection.get to an excluded repo, not a crash", async () => {
    mocks.connectionListHandler.mockResolvedValue({
      connections: [connection("con-ok"), connection("con-bad")],
    });
    mocks.connectionGetHandler.mockImplementation(
      async ({ connectionId }: { connectionId: string }) => {
        if (connectionId === "con-bad") throw new Error("boom");
        return { deliveryConfig: { owner: "o", repo: "r", defaultBranch: "main" } };
      },
    );

    const result = await loadCodeModeOptions("org-1", "ws-1", ctx);
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]?.connectionId).toBe("con-ok");
  });

  it("never throws — a total failure degrades to empty options", async () => {
    mocks.runInTenantScope.mockRejectedValue(new Error("scope exploded"));
    const result = await loadCodeModeOptions("org-1", "ws-1", ctx);
    expect(result).toEqual({ repos: [], environments: [] });
  });

  it("filters environments to active ones", async () => {
    mocks.connectionListHandler.mockResolvedValue({ connections: [] });
    mocks.environmentListHandler.mockResolvedValue({
      environments: [
        { id: "e1", name: "prod", isActive: true, isDefault: true },
        { id: "e2", name: "old", isActive: false, isDefault: false },
      ],
    });

    const result = await loadCodeModeOptions("org-1", "ws-1", ctx);
    expect(result.environments).toEqual([
      { id: "e1", name: "prod", isDefault: true },
    ]);
  });
});
