// The flyout's engine read (engine-actions.ts), over a stubbed data source: it
// resolves the viewer of the workspace the person is standing in before it
// reads, hands that viewer to the port, and answers a refused read with the
// reason the port gave rather than a bare no.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";

const { source, requireViewer } = vi.hoisted(() => ({
  source: { shell: { assistantEngine: vi.fn() } },
  requireViewer: vi.fn(),
}));
vi.mock("@/data/source", () => ({ dataSource: () => source }));
vi.mock("@/server/viewer", () => ({ requireViewer }));

const { readAssistantEngine } = await import("./engine-actions");

const viewer = { wsSlug: "core-platform" };

beforeEach(() => {
  vi.clearAllMocks();
  requireViewer.mockResolvedValue(viewer);
});

describe("readAssistantEngine", () => {
  it("reads the port for the workspace in the URL, as that workspace's viewer", async () => {
    source.shell.assistantEngine.mockResolvedValue(
      readOk({ state: "unreachable", error: "ECONNREFUSED" }),
    );

    expect(await readAssistantEngine("acme", "core-platform")).toEqual({
      ok: true,
      value: { state: "unreachable", error: "ECONNREFUSED" },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(source.shell.assistantEngine).toHaveBeenCalledWith(viewer);
  });

  it("answers a failed read with the port's code (negative)", async () => {
    source.shell.assistantEngine.mockResolvedValue(
      readError("record_unmappable", 502),
    );

    expect(await readAssistantEngine("acme", "core-platform")).toEqual({
      ok: false,
      reason: "unavailable",
      code: "record_unmappable",
    });
  });

  it("reads nothing when the viewer cannot be resolved (negative)", async () => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));

    await expect(readAssistantEngine("acme", "elsewhere")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(source.shell.assistantEngine).not.toHaveBeenCalled();
  });
});
