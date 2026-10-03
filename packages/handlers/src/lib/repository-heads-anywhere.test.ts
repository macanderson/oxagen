// repository-heads-anywhere.ts reads every head one repository has, on the
// shared plane and on each dedicated plane (ADR-042). `create_github_token`
// asks it whether any workspace steers by a repository (ADR-293), so a head on
// a dedicated plane must count as much as one on the shared plane.
//
// The reads are fakes. The Postgres read is proven against the real store in
// repository.pg.test.ts.
import { describe, expect, it, vi } from "vitest";
import {
  type HeadRow,
  type HeadScope,
  headsAnywhere,
  type RepositoryHeadReads,
  steeringAnywhere,
} from "./repository-heads-anywhere";

const head = (workspaceId: string, role: string): HeadRow => ({
  orgId: `org-${workspaceId}`,
  workspaceId,
  role,
});

/** Reads that answer from a shared list and a per-workspace dedicated map. */
function reads(
  shared: HeadRow[],
  dedicated: Record<string, HeadRow[]> = {},
): RepositoryHeadReads {
  return {
    sharedHeads: vi.fn<RepositoryHeadReads["sharedHeads"]>(async () => [
      ...shared,
    ]),
    dedicatedScopes: vi.fn<RepositoryHeadReads["dedicatedScopes"]>(
      async (): Promise<HeadScope[]> =>
        Object.keys(dedicated).map((workspaceId) => ({
          orgId: `org-${workspaceId}`,
          workspaceId,
        })),
    ),
    headsOnPlane: vi.fn<RepositoryHeadReads["headsOnPlane"]>(
      async (scope) => dedicated[scope.workspaceId] ?? [],
    ),
  };
}

describe("headsAnywhere", () => {
  it("reads the shared plane, then each dedicated workspace the shared read did not see", async () => {
    const deps = reads([head("ws-a", "linked")], {
      "ws-a": [head("ws-a", "linked")],
      "ws-d": [head("ws-d", "steering")],
    });
    await expect(headsAnywhere("github", "42", deps)).resolves.toEqual([
      head("ws-a", "linked"),
      head("ws-d", "steering"),
    ]);
    expect(deps.sharedHeads).toHaveBeenCalledWith("github", "42");
    // ws-a was on the shared read, so only ws-d is read on its plane.
    expect(deps.headsOnPlane).toHaveBeenCalledTimes(1);
    expect(deps.headsOnPlane).toHaveBeenCalledWith(
      { orgId: "org-ws-d", workspaceId: "ws-d" },
      "github",
      "42",
    );
  });
});

describe("steeringAnywhere", () => {
  it("is true when a workspace on the shared plane steers by the repository", async () => {
    const deps = reads([head("ws-a", "steering"), head("ws-b", "linked")]);
    await expect(steeringAnywhere("github", "42", deps)).resolves.toBe(true);
  });

  it("is true when only a workspace on a dedicated plane steers by it", async () => {
    const deps = reads([head("ws-b", "linked")], {
      "ws-d": [head("ws-d", "steering")],
    });
    await expect(steeringAnywhere("github", "42", deps)).resolves.toBe(true);
  });

  it("is false when every workspace only links the repository (negative)", async () => {
    const deps = reads([head("ws-a", "linked"), head("ws-b", "linked")], {
      "ws-d": [head("ws-d", "linked")],
    });
    await expect(steeringAnywhere("github", "42", deps)).resolves.toBe(false);
  });

  it("is false for a repository no workspace binds (negative)", async () => {
    await expect(steeringAnywhere("github", "42", reads([]))).resolves.toBe(
      false,
    );
  });
});
