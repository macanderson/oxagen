// The repository tree triage reads (P1-03, #5103), over fakes. A tree that
// cannot be read leaves triage to predict paths from the item alone, so a
// token or fetch that throws answers no tree and logs the miss
// (runner.ts:83). work-intake.pg.test.ts reads the tree through Postgres and
// covers the non-OK answer.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectorRecord } from "@oxagen/ingestion/collectors";

const mocks = vi.hoisted(() => ({
  getCollector: vi.fn(),
  resolveGitHubToken: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../../logger", () => ({ logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() } }));
vi.mock("@oxagen/github/workspace-token", () => ({ resolveGitHubToken: mocks.resolveGitHubToken }));
vi.mock("./collector-store", () => ({ postgresCollectorStore: () => ({ getCollector: mocks.getCollector }) }));

const { githubFileTrees } = await import("./runner");

const scope = { orgId: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002" };
const item = { repository: "acme/web", collectorId: "col-1" };

const collector: CollectorRecord = {
  id: "col-1",
  orgId: scope.orgId,
  workspaceId: scope.workspaceId,
  name: "github",
  type: "github",
  connectionId: "conn-1",
  scope: { repos: ["acme/web"] },
  health: "healthy",
  cursor: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

beforeEach(() => {
  mocks.getCollector.mockReset();
  mocks.resolveGitHubToken.mockReset();
  mocks.getCollector.mockResolvedValue(collector);
  mocks.resolveGitHubToken.mockResolvedValue("ghs_token");
});

describe("githubFileTrees", () => {
  it("answers no tree and logs the miss when the tree fetch throws", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await githubFileTrees(scope, item, fetcher)).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ repository: "acme/web", err: expect.any(TypeError) }),
      expect.stringContaining("the repository tree did not read"),
    );
  });

  it("answers no tree and fetches nothing when the installation token cannot be minted", async () => {
    mocks.resolveGitHubToken.mockRejectedValue(new Error("The installation was removed."));
    const fetcher = vi.fn();
    expect(await githubFileTrees(scope, item, fetcher)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.resolveGitHubToken).toHaveBeenCalledWith({ ...scope, connectionId: "conn-1" });
    expect(mocks.warn).toHaveBeenCalledOnce();
  });
});
