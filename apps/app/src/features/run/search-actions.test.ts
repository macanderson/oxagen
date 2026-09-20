import { runList } from "@oxagen/oxagen/contracts/run.list";
import { runGet } from "@oxagen/oxagen/contracts/run.get";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireViewer, list, get } = vi.hoisted(() => ({
  requireViewer: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
}));
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("@/data/source", () => ({
  dataSource: () => ({ runs: { list, get } }),
}));
const { searchBisectRuns, readRunDiff } = await import("./search-actions");

beforeEach(() => {
  vi.resetAllMocks();
});

describe("bisect reads", () => {
  it("resolves the workspace viewer, bounds results, and excludes the current run", async () => {
    const ctx = Symbol("resolved viewer");
    requireViewer.mockResolvedValue(ctx);
    kernelRead.mockResolvedValue({ ok: true, value: { runs: [], nextCursor: null } });
    const query = {
      cursor: "older",
      search: "fix",
      repository: "oxagen",
      harness: "codex",
    };
    await searchBisectRuns("acme", "core", "tse_current", query);
    expect(requireViewer).toHaveBeenCalledWith("acme", "core");
    expect(list).toHaveBeenCalledWith(ctx, {
      ...query,
      excludeRunId: "tse_current",
      limit: 20,
    });
  });

  it("does not read the index before viewer authorization", async () => {
    requireViewer.mockRejectedValue(new Error("not found"));
    await expect(
      searchBisectRuns("other", "private", "tse_current", { cursor: null }),
    ).rejects.toThrow("not found");
    expect(kernelRead).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, reason: "denied", permission: "workspace.read" },
    { ok: false, reason: "pending_approval", accessRequestId: "apr_wait" },
    { ok: false, reason: "error", code: "unavailable", status: 503 },
  ])("preserves the port refusal: $reason", async (failure) => {
    kernelRead.mockResolvedValue(failure);
    expect(
      await searchBisectRuns("acme", "core", "tse_current", { cursor: null }),
    ).toEqual(failure);
  });

  it("opts into diff bytes and returns only the diff", async () => {
    const ctx = Symbol("resolved viewer");
    const diff = {
      patch: "+change",
      truncated: false,
      complete: true,
      seq: "5",
    };
    requireViewer.mockResolvedValue(ctx);
    kernelRead.mockResolvedValue({ ok: true, value: { diff, run: {}, frames: {} } });
    expect(await readRunDiff("acme", "core", "tse_other")).toEqual({
      ok: true,
      value: diff,
    });
    expect(get).toHaveBeenCalledWith(ctx, "tse_other", {
      framesAfter: null,
      includeDiff: true,
    });
  });
});
