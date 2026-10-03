import { describe, expect, it } from "vitest";
import { changeEventKind } from "./change-event";

const commit = {
  sha: "abc123",
  message: "Add x",
  author: "Dev",
  committedAt: "2026-09-27T11:30:00Z",
  git_branch: "main",
};

describe("changeEventKind", () => {
  it("sends entity.created for a new node", () => {
    expect(
      changeEventKind({
        created: true,
        backfill: false,
        properties: commit,
        previousProperties: null,
      }),
    ).toBe("created");
  });

  it("sends nothing for a backfill write, new node or not", () => {
    for (const created of [true, false])
      expect(
        changeEventKind({
          created,
          backfill: true,
          properties: commit,
          previousProperties: created ? null : { ...commit, message: "old" },
        }),
      ).toBeNull();
  });

  it("sends nothing for an update that stores the values the node held", () => {
    // The stored JSON drops undefined values and may hold keys in another
    // order. Neither is a change.
    const stored = {
      git_branch: "main",
      committedAt: "2026-09-27T11:30:00Z",
      author: "Dev",
      message: "Add x",
      sha: "abc123",
    };
    expect(
      changeEventKind({
        created: false,
        backfill: false,
        properties: { ...commit, authorEmail: undefined },
        previousProperties: stored,
      }),
    ).toBeNull();
  });

  it("sends entity.updated when a value changed", () => {
    expect(
      changeEventKind({
        created: false,
        backfill: false,
        properties: commit,
        previousProperties: { ...commit, git_branch: "feat/x" },
      }),
    ).toBe("updated");
    expect(
      changeEventKind({
        created: false,
        backfill: false,
        properties: { labels: ["a", "b"] },
        previousProperties: { labels: ["b", "a"] },
      }),
    ).toBe("updated");
  });

  it("sends entity.updated when a property appears or goes away", () => {
    const withoutBranch: Record<string, unknown> = { ...commit };
    delete withoutBranch["git_branch"];
    expect(
      changeEventKind({
        created: false,
        backfill: false,
        properties: commit,
        previousProperties: withoutBranch,
      }),
    ).toBe("updated");
    expect(
      changeEventKind({
        created: false,
        backfill: false,
        properties: withoutBranch,
        previousProperties: commit,
      }),
    ).toBe("updated");
  });

  it("sends entity.updated when the earlier values are unknown", () => {
    expect(
      changeEventKind({
        created: false,
        backfill: false,
        properties: commit,
        previousProperties: null,
      }),
    ).toBe("updated");
  });
});
