// The changes port: kernel reads on the workspace ctx, each mapped into its
// view model, with a refusal passed through and an unmappable record reported
// once. A line count the forge did not report stays null (INV-08), and the
// read names the page that asked, so a denial names that page's permission.
import { changeSetGet } from "@oxagen/oxagen/contracts/forge.changes.get";
import { revisionDiffGet } from "@oxagen/oxagen/contracts/forge.revision.diff.get";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { changes } = await import("./changes");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

/** A pull request as `get_change_set` answers it. */
function pullOut(over: Record<string, unknown> = {}) {
  return {
    id: "fpr_01k5ru4a",
    provider: "github",
    repository: "acme/platform",
    number: 482,
    url: "https://github.com/acme/platform/pull/482",
    title: "Release 3.2",
    state: "open",
    headSha: "9f8e7d6c5b4a",
    baseRef: "main",
    headRef: "release/3.2",
    mergedAt: null,
    closedAt: null,
    stateSeenAt: "2026-10-03T09:00:00.000Z",
    revision: {
      id: "prv_01k5ru4b",
      headSha: "9f8e7d6c5b4a",
      mergeBaseSha: "1a2b3c4d",
      diffStatus: "stored",
      complete: true,
      limitations: [],
      filesChanged: 2,
      additions: 12,
      deletions: 3,
      diffBytes: 2048,
      capturedAt: "2026-10-03T09:00:01.000Z",
    },
    files: [
      {
        path: "src/app.ts",
        status: "modified",
        additions: 10,
        deletions: 3,
      },
      {
        path: "docs/new.md",
        previousPath: "docs/old.md",
        status: "renamed",
        additions: 2,
        deletions: 0,
      },
    ],
    moreFiles: false,
    ...over,
  };
}

const changeSetOut = {
  scope: "run",
  id: "tse_7k2m9q",
  pullRequests: [pullOut()],
  morePullRequests: false,
  repositories: [
    {
      provider: "github",
      repository: "acme/platform",
      pullRequests: 1,
      filesChanged: 2,
      additions: 12,
      deletions: 3,
      files: [
        {
          path: "src/app.ts",
          pullRequestIds: ["fpr_01k5ru4a"],
          additions: 10,
          deletions: 3,
        },
        {
          path: "docs/new.md",
          pullRequestIds: ["fpr_01k5ru4a"],
          additions: 2,
          deletions: 0,
        },
      ],
      moreFiles: false,
    },
  ],
};

describe("changes.changeSet", () => {
  it("reads a run's change set on the Run page and maps it", async () => {
    kernelRead.mockResolvedValue(readOk(changeSetOut));
    const read = await changes.changeSet(ctx, "run", "tse_7k2m9q");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: changeSetGet,
      input: { scope: "run", id: "tse_7k2m9q" },
      page: "run",
    });
    if (!read.ok) throw new Error("a change set");
    expect(read.value.scope).toBe("run");
    expect(read.value).not.toHaveProperty("id");
    const [pull] = read.value.pullRequests;
    expect(pull?.revision?.id).toBe("prv_01k5ru4b");
    expect(pull?.files).toEqual([
      {
        path: "src/app.ts",
        previousPath: null,
        status: "modified",
        additions: 10,
        deletions: 3,
      },
      {
        path: "docs/new.md",
        previousPath: "docs/old.md",
        status: "renamed",
        additions: 2,
        deletions: 0,
      },
    ]);
    expect(read.value.repositories[0]?.files[0]?.pullRequestIds).toEqual([
      "fpr_01k5ru4a",
    ]);
  });

  it("reads a work item's change set on the work item page", async () => {
    kernelRead.mockResolvedValue(
      readOk({ ...changeSetOut, scope: "work_item", id: "wi_12ab" }),
    );
    await changes.changeSet(ctx, "work_item", "wi_12ab");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: changeSetGet,
      input: { scope: "work_item", id: "wi_12ab" },
      page: "work",
    });
  });

  it("reads an issue by its URL on the Run page", async () => {
    const url = "https://github.com/acme/platform/issues/12";
    kernelRead.mockResolvedValue(
      readOk({
        scope: "issue",
        id: url,
        pullRequests: [],
        morePullRequests: false,
        repositories: [],
      }),
    );
    const read = await changes.changeSet(ctx, "issue", url);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: changeSetGet,
      input: { scope: "issue", id: url },
      page: "run",
    });
    expect(read).toEqual(
      readOk({
        scope: "issue",
        pullRequests: [],
        morePullRequests: false,
        repositories: [],
      }),
    );
  });

  it("keeps a line count the forge did not report as null, never zero", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        ...changeSetOut,
        pullRequests: [
          pullOut({
            revision: null,
            files: [
              {
                path: "bin/tool",
                status: "added",
                additions: null,
                deletions: null,
              },
            ],
          }),
        ],
        repositories: [
          {
            ...changeSetOut.repositories[0],
            additions: null,
            deletions: null,
          },
        ],
      }),
    );
    const read = await changes.changeSet(ctx, "run", "tse_7k2m9q");
    if (!read.ok) throw new Error("a change set");
    const [pull] = read.value.pullRequests;
    expect(pull?.revision).toBeNull();
    expect(pull?.files[0]).toMatchObject({ additions: null, deletions: null });
    expect(read.value.repositories[0]).toMatchObject({
      additions: null,
      deletions: null,
    });
  });

  it("passes a refusal through (negative)", async () => {
    const refused = { ok: false, reason: "denied", permission: "run.read" };
    kernelRead.mockResolvedValue(refused);
    expect(await changes.changeSet(ctx, "run", "tse_7k2m9q")).toEqual(refused);
  });

  it("reports a record the view refuses once, as record_unmappable (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        ...changeSetOut,
        pullRequests: [pullOut({ id: "not a public id" })],
      }),
    );
    expect(await changes.changeSet(ctx, "run", "tse_7k2m9q")).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0]?.[0]).toMatchObject({
      context: "changes.changeSet record_unmappable",
    });
  });
});

describe("changes.revisionDiff", () => {
  const diffOut = {
    revisionId: "prv_01k5ru4b",
    pullRequestId: "fpr_01k5ru4a",
    headSha: "9f8e7d6c5b4a",
    mergeBaseSha: "1a2b3c4d",
    diffStatus: "stored",
    complete: true,
    limitations: [],
    diffSha256: "ab".repeat(32),
    files: [
      {
        path: "src/app.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1,1 +1,1 @@\n-old\n+new",
        binary: false,
        truncated: false,
      },
    ],
    truncated: false,
  };

  it("reads one revision's files by path and maps them", async () => {
    kernelRead.mockResolvedValue(readOk(diffOut));
    const read = await changes.revisionDiff(ctx, "prv_01k5ru4b", [
      "src/app.ts",
    ]);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: revisionDiffGet,
      input: { revisionId: "prv_01k5ru4b", paths: ["src/app.ts"] },
      page: "run",
    });
    expect(read).toEqual(
      readOk({
        ...diffOut,
        files: [{ ...diffOut.files[0], previousPath: null }],
      }),
    );
  });

  it("sends no path filter when none is given", async () => {
    kernelRead.mockResolvedValue(readOk(diffOut));
    await changes.revisionDiff(ctx, "prv_01k5ru4b");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: revisionDiffGet,
      input: { revisionId: "prv_01k5ru4b" },
      page: "run",
    });
  });

  it("passes a refusal through (negative)", async () => {
    const missing = readError("not_found", 404);
    kernelRead.mockResolvedValue(missing);
    expect(await changes.revisionDiff(ctx, "prv_missing")).toEqual(missing);
  });
});
