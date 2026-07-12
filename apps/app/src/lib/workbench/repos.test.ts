/**
 * repos.test.ts — unit tests for the Workbench repos wrapper's
 * `listReposWithMetrics`, whose defining behavior is per-connection
 * degradation: one connection's `get_repo_metrics` failure must not blank
 * out the whole repo list — only that row loses its metrics, with
 * `metricsError` set so the UI can render a per-row failure state.
 *
 * Mirrors repos/actions.test.ts's mock style (mock @oxagen/oxagen's invoke),
 * per repos.ts's own doc comment: it calls invoke() directly with a
 * `WorkbenchCtx` — no runInTenantScope wrapping happens in this module (that
 * lives one layer up, in actions.ts), so only invoke() needs mocking here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen", () => ({
  invoke: mockInvoke,
}));

import {
  listReposWithMetrics,
  listRepoConnections,
  getRepoMetrics,
} from "./repos";
import type { WorkbenchCtx } from "./scope";

const CTX: WorkbenchCtx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app",
  messageId: null,
};

function connection(
  publicId: string,
  displayName: string,
): Record<string, unknown> {
  return { publicId, displayName, connectorId: "github" };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listRepoConnections", () => {
  it("lists GitHub-typed connections via list_connections", async () => {
    mockInvoke.mockResolvedValueOnce({
      connections: [connection("repo-1", "acme/widgets")],
    });

    const out = await listRepoConnections(CTX);

    expect(out).toEqual([connection("repo-1", "acme/widgets")]);
    expect(mockInvoke).toHaveBeenCalledWith(
      "list_connections",
      { connectorId: "github" },
      CTX,
      { surface: "agent" },
    );
  });
});

describe("listReposWithMetrics", () => {
  it("attaches metrics to every connection when all repo.metrics calls succeed", async () => {
    mockInvoke.mockImplementation((capability: string, input: unknown) => {
      if (capability === "list_connections") {
        return Promise.resolve({
          connections: [
            connection("repo-1", "acme/one"),
            connection("repo-2", "acme/two"),
          ],
        });
      }
      if (capability === "get_repo_metrics") {
        const { repoId } = input as { repoId: string };
        return Promise.resolve({ openPrs: repoId === "repo-1" ? 1 : 2 });
      }
      throw new Error(`unexpected capability ${capability}`);
    });

    const rows = await listReposWithMetrics(CTX);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      publicId: "repo-1",
      metrics: { openPrs: 1 },
      metricsError: null,
    });
    expect(rows[1]).toMatchObject({
      publicId: "repo-2",
      metrics: { openPrs: 2 },
      metricsError: null,
    });
  });

  it("degrades only the failing connection's row when one repo.metrics call throws", async () => {
    mockInvoke.mockImplementation((capability: string, input: unknown) => {
      if (capability === "list_connections") {
        return Promise.resolve({
          connections: [
            connection("repo-1", "acme/good"),
            connection("repo-2", "acme/bad"),
            connection("repo-3", "acme/also-good"),
          ],
        });
      }
      if (capability === "get_repo_metrics") {
        const { repoId } = input as { repoId: string };
        if (repoId === "repo-2") {
          return Promise.reject(new Error("Repo API rate limited"));
        }
        return Promise.resolve({ openPrs: 0 });
      }
      throw new Error(`unexpected capability ${capability}`);
    });

    const rows = await listReposWithMetrics(CTX);

    expect(rows).toHaveLength(3);
    // The failing connection degrades but is still present in the list.
    expect(rows.find((r) => r.publicId === "repo-2")).toMatchObject({
      metrics: null,
      metricsError: "Repo API rate limited",
    });
    // The other two connections are unaffected by repo-2's failure.
    expect(rows.find((r) => r.publicId === "repo-1")).toMatchObject({
      metrics: { openPrs: 0 },
      metricsError: null,
    });
    expect(rows.find((r) => r.publicId === "repo-3")).toMatchObject({
      metrics: { openPrs: 0 },
      metricsError: null,
    });
  });

  it("falls back to a generic message when the thrown value is not an Error", async () => {
    mockInvoke.mockImplementation((capability: string) => {
      if (capability === "list_connections") {
        return Promise.resolve({
          connections: [connection("repo-1", "acme/weird")],
        });
      }
      if (capability === "get_repo_metrics") {
        // Intentionally reject with a non-Error to cover the fallback branch
        // that stringifies a non-Error thrown value.
        return Promise.reject("boom");
      }
      throw new Error(`unexpected capability ${capability}`);
    });

    const rows = await listReposWithMetrics(CTX);

    expect(rows).toEqual([
      expect.objectContaining({
        publicId: "repo-1",
        metrics: null,
        metricsError: "Failed to load metrics.",
      }),
    ]);
  });

  it("returns an empty list when there are no GitHub connections", async () => {
    mockInvoke.mockResolvedValueOnce({ connections: [] });

    const rows = await listReposWithMetrics(CTX);

    expect(rows).toEqual([]);
  });
});

describe("getRepoMetrics", () => {
  it("invokes get_repo_metrics with the given repoId", async () => {
    mockInvoke.mockResolvedValueOnce({ openPrs: 3 });

    const out = await getRepoMetrics(CTX, "repo-1");

    expect(out).toEqual({ openPrs: 3 });
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_repo_metrics",
      { repoId: "repo-1" },
      CTX,
      { surface: "agent" },
    );
  });
});
