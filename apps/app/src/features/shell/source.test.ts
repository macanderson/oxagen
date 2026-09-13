import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveShell } from "@/data/adapters/live/shell";
import { FIXTURE_TENANT } from "@/data/fixture-tenant";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { FIXTURE_USER } from "@/server/fixture-session";

const requireViewer = vi.fn();
vi.mock("@/server/scope", () => ({ requireViewer }));

const scope = {
  orgId: FIXTURE_TENANT.orgId,
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};

beforeEach(() => {
  requireViewer.mockReset();
  requireViewer.mockResolvedValue({ userId: FIXTURE_USER.id, scope });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shellSource", () => {
  it("reads through dataSource().shell for the viewer requireViewer admits", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "fixture");
    const { shellSource } = await import("./source");
    const { fixtureSource } = await import("@/data/adapters/fixture");
    const source = await shellSource("acme");
    expect(requireViewer).toHaveBeenCalledWith("acme");
    expect(source).toEqual({
      port: fixtureSource.shell,
      scope,
      userId: FIXTURE_USER.id,
    });
  });

  it("never serves fixtures in a production build, even with MC_DATA=fixture (negative)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_DATA", "fixture");
    const { shellSource } = await import("./source");
    expect((await shellSource("acme")).port).toBe(liveShell);
  });

  it("serves live reads when the live source is selected (negative)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "live");
    const { shellSource } = await import("./source");
    expect((await shellSource("acme")).port).toBe(liveShell);
  });

  it("reads nothing when requireViewer refuses the organization", async () => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    const { shellSource } = await import("./source");
    await expect(shellSource("globex")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
