// shellSource: the viewer gate first, then the one data source's shell port.
// Which adapter dataSource() selects (and that production never selects the
// fixture) is src/data/source.test.ts's to prove; this file proves the shell
// reads through it and reads nothing for a refused organization.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_TENANT } from "@/data/fixture-tenant";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { FIXTURE_USER } from "@/server/fixture-session";

const requireViewer = vi.fn();
vi.mock("@/server/scope", () => ({ requireViewer }));
const shellPort = { context: vi.fn() };
const dataSource = vi.fn(() => Promise.resolve({ shell: shellPort }));
vi.mock("@/data/source", () => ({ dataSource }));

const { shellSource } = await import("./source");

const scope = {
  orgId: FIXTURE_TENANT.orgId,
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};

beforeEach(() => {
  requireViewer.mockReset();
  requireViewer.mockResolvedValue({ userId: FIXTURE_USER.id, scope });
  dataSource.mockClear();
});

describe("shellSource", () => {
  it("reads through dataSource().shell for the viewer requireViewer admits", async () => {
    expect(await shellSource("acme")).toEqual({
      port: shellPort,
      scope,
      userId: FIXTURE_USER.id,
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
