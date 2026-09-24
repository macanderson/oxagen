// The command menu's search: one `search_tools` read on the viewer the URL
// resolves, the query and nothing that names a tenant, and a refusal returned
// as the action's own.
import { toolsSearch } from "@oxagen/oxagen/contracts/tools.search";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, requireViewer } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  requireViewer: vi.fn(),
}));
vi.mock("@/server/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/kernel")>()),
  kernelRead,
}));
vi.mock("@/server/viewer", () => ({ requireViewer }));

const { searchCommands } = await import("./command-actions");

const ctx = { orgSlug: "acme", wsSlug: "core-platform" };

beforeEach(() => {
  kernelRead.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("searchCommands", () => {
  it("reads search_tools on the viewer the URL resolves and returns its rows", async () => {
    const rows = [
      {
        kind: "run",
        id: "arun_7k2m9q",
        label: "Cut 4.11.0 release notes",
        contextLine: "live",
      },
      {
        kind: "tool",
        id: "list_runs",
        label: "list_runs",
        contextLine: "List the workspace's runs",
      },
    ];
    kernelRead.mockResolvedValue({ ok: true, value: { rows } });
    expect(await searchCommands("acme", "core-platform", "release")).toEqual({
      ok: true,
      value: { rows },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: toolsSearch,
      input: { query: "release" },
      page: "shell",
    });
  });

  it("returns a refusal as the action's own (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "search_tools",
    });
    const out = await searchCommands("acme", "core-platform", "");
    expect(out.ok).toBe(false);
    expect(out.ok ? null : out.reason).toBe("denied");
  });

  it("refuses a query longer than search_tools accepts before reading anything (negative)", async () => {
    const out = await searchCommands("acme", "core-platform", "x".repeat(501));
    expect(out).toEqual({
      ok: false,
      reason: "invalid",
      code: "too_long",
      field: "query",
    });
    expect(kernelRead).not.toHaveBeenCalled();
    expect(requireViewer).not.toHaveBeenCalled();
  });
});
