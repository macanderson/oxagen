// shellSource: the viewer gate first, then the one data source's shell port.
// This file proves the shell reads through dataSource() and reads nothing for
// a refused organization.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";

const requireViewer = vi.fn();
vi.mock("@/server/scope", () => ({ requireViewer }));
const shellPort = { context: vi.fn() };
const dataSource = vi.fn(() => ({ shell: shellPort }));
vi.mock("@/data/source", () => ({ dataSource }));

const { shellSource } = await import("./source");

const USER_ID = "usr_marcusbell";
const scope = {
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};

beforeEach(() => {
  requireViewer.mockReset();
  requireViewer.mockResolvedValue({ userId: USER_ID, scope });
  dataSource.mockClear();
});

describe("shellSource", () => {
  it("reads through dataSource().shell for the viewer requireViewer admits", async () => {
    expect(await shellSource("acme")).toEqual({
      port: shellPort,
      scope,
      userId: USER_ID,
    });
    expect(requireViewer).toHaveBeenCalledWith("acme");
    expect(dataSource).toHaveBeenCalledTimes(1);
  });

  it("reads nothing when requireViewer refuses the organization (negative)", async () => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(shellSource("globex")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(dataSource).not.toHaveBeenCalled();
  });
});
