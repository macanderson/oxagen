import { describe, expect, it } from "vitest";
import type {
  InstallationRepositories,
  RepositoryTree,
  WorkspaceRepositories,
} from "@/data/contracts/repository";
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
  head: "0123456789abcdef0123",
  oxagen: { present: true, files: [".oxagen/workspace.toml"] },
  workspaceToml: null,
  governanceToml: null,
  governanceMode: "team",
  initPullRequest: null,
  readAt: "2026-09-19T10:00:00.000Z",
};

describe("treeState", () => {
  it("says what the row's tree read answered, in every state the read can be in", () => {
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
  const bound = (
    bindingId: string,
    role: "main" | "linked",
    fullName: string,
  ): WorkspaceRepositories["repositories"][number] => ({
    bindingId,
    role,
    owner: fullName.split("/")[0] ?? "",
    name: fullName.split("/")[1] ?? "",
    fullName,
    defaultRef: "main",
    htmlUrl: `https://github.com/${fullName}`,
    boundAt: "2026-09-16T10:00:00.000Z",
    connectionLive: true,
    events: "installed",
  });
  const reachable = (
    fullName: string,
    isPrivate: boolean,
  ): InstallationRepositories["repositories"][number] => ({
    id: fullName,
    owner: fullName.split("/")[0] ?? "",
    name: fullName.split("/")[1] ?? "",
    fullName,
    defaultBranch: "trunk",
    private: isPrivate,
    htmlUrl: `https://github.com/${fullName}`,
  });

  it("puts main first whatever order the list answered in, keeps linked in order, and appends what nobody bound", () => {
    const rows = repositoryRows(
      [
        bound("rpb_l1", "linked", "acme/docs"),
        bound("rpb_l2", "linked", "acme/site"),
        bound("rpb_m1", "main", "acme/platform"),
      ],
      { rpb_m1: { kind: "ready", value: TREE } },
      [
        reachable("ACME/Docs", false),
        reachable("acme/platform", true),
        reachable("acme/infra", false),
      ],
    );
    expect(rows.map((row) => [row.fullName, row.role])).toEqual([
      ["acme/platform", "main"],
      ["acme/docs", "linked"],
      ["acme/site", "linked"],
      ["acme/infra", "available"],
    ]);
    // Matched without case; unmatched bound rows have no visibility to say.
    expect(rows.map((row) => row.visibility)).toEqual([
      "private",
      "public",
      null,
      "public",
    ]);
    // A bound row whose tree was not asked for yet reads as loading; a row
    // nobody bound has no tree at all and takes GitHub's default branch.
    expect(rows[0]?.tree).toEqual({ kind: "ready", value: TREE });
    expect(rows[1]?.tree).toEqual({ kind: "loading" });
    expect(rows[3]).toMatchObject({
      bindingId: null,
      productionBranch: "trunk",
      events: null,
      tree: null,
    });
  });

  it("marks a private repository nobody bound as private", () => {
    const [row] = repositoryRows([], {}, [reachable("acme/secret", true)]);
    expect(row?.visibility).toBe("private");
  });
});
