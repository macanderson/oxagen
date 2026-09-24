import { describe, expect, it } from "vitest";
import type { RepositoryTree } from "@/data/contracts/repository";
import { parseRepositoryView, repositoryRows, treeState } from "./view";

describe("parseRepositoryView", () => {
  it("reads the bare route as the Repositories tab", () => {
    expect(parseRepositoryView(undefined)).toEqual({
      tab: "repositories",
      change: null,
    });
    expect(parseRepositoryView([])).toEqual({
      tab: "repositories",
      change: null,
    });
  });

  it("reads each other tab from its one path segment", () => {
    expect(parseRepositoryView(["working-copies"])?.tab).toBe("working-copies");
    expect(parseRepositoryView(["changes"])).toEqual({
      tab: "changes",
      change: null,
    });
    expect(parseRepositoryView(["configuration"])?.tab).toBe("configuration");
  });

  it("reads one change on the Changes tab", () => {
    expect(parseRepositoryView(["changes", "oxpr_01K6T4B7"])).toEqual({
      tab: "changes",
      change: "oxpr_01K6T4B7",
    });
  });

  it("refuses an unknown segment, a change on another tab, a third segment, and the first tab spelled out (negative)", () => {
    expect(parseRepositoryView(["settings"])).toBeNull();
    expect(parseRepositoryView(["configuration", "prp_1"])).toBeNull();
    expect(parseRepositoryView(["changes", "prp_1", "x"])).toBeNull();
    expect(parseRepositoryView(["changes", "a b"])).toBeNull();
    expect(parseRepositoryView(["repositories"])).toBeNull();
  });
});

const TREE: RepositoryTree = {
  bindingId: "rpb_main01",
  role: "main",
  fullName: "acme/platform",
  productionBranch: "main",
  githubDefaultBranch: "main",
  head: "0123456789abcdef",
  oxagen: { present: true, files: [".oxagen/workspace.toml"] },
  workspaceToml: null,
  governanceToml: null,
  governanceMode: "team",
  initPullRequest: null,
  readAt: "2026-09-19T10:00:00.000Z",
};

describe("treeState", () => {
  it("names each state a tree read can leave a row in", () => {
    expect(treeState(null)).toBe("unknown");
    expect(treeState({ kind: "loading" })).toBe("reading");
    expect(
      treeState({
        kind: "failed",
        failure: { ok: false, reason: "unavailable", code: "github_down" },
      }),
    ).toBe("unread");
    expect(treeState({ kind: "ready", value: { ...TREE, head: null } })).toBe(
      "branchMissing",
    );
    expect(treeState({ kind: "ready", value: TREE })).toBe("governed");
    expect(
      treeState({
        kind: "ready",
        value: { ...TREE, oxagen: { present: false, files: [] } },
      }),
    ).toBe("absent");
  });
});

describe("repositoryRows", () => {
  const bound = (role: "main" | "linked", fullName: string) => {
    const [owner = "", name = ""] = fullName.split("/");
    return {
      bindingId: `rpb_${name}`,
      role,
      owner,
      name,
      fullName,
      defaultRef: "main",
      htmlUrl: `https://github.com/${fullName}`,
      boundAt: "2026-09-16T10:00:00.000Z",
      connectionLive: true,
      events: "installed" as const,
    };
  };
  const reached = (fullName: string, isPrivate: boolean) => {
    const [owner = "", name = ""] = fullName.split("/");
    return {
      id: name,
      owner,
      name,
      fullName,
      defaultBranch: "trunk",
      private: isPrivate,
      htmlUrl: `https://github.com/${fullName}`,
    };
  };

  it("puts main first, matches the installation's list without case, and adds what nobody bound as not linked", () => {
    const rows = repositoryRows(
      [bound("linked", "acme/docs"), bound("main", "acme/platform")],
      {},
      [
        reached("ACME/Platform", false),
        reached("acme/docs", true),
        reached("acme/infra", false),
      ],
    );
    expect(rows.map((row) => [row.fullName, row.role])).toEqual([
      ["acme/platform", "main"],
      ["acme/docs", "linked"],
      ["acme/infra", "available"],
    ]);
    expect(rows[0]?.visibility).toBe("public");
    expect(rows[1]?.visibility).toBe("private");
    // A bound row with no tree read yet reads as loading; one nobody bound has none.
    expect(rows[0]?.tree).toEqual({ kind: "loading" });
    expect(rows[2]?.tree).toBeNull();
    expect(rows[2]?.productionBranch).toBe("trunk");
  });

  it("leaves visibility unrecorded for a bound repository the installation no longer lists (negative)", () => {
    const [row] = repositoryRows([bound("main", "acme/platform")], {}, []);
    expect(row?.visibility).toBeNull();
  });
});
