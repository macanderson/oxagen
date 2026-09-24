import { describe, expect, it } from "vitest";
import { deriveSessionTitle } from "./session-title";

describe("deriveSessionTitle", () => {
  it("leads with the place, because that is what tells two runs apart", () => {
    expect(
      deriveSessionTitle({ projectDir: "/home/dev/oxagen", filesChanged: 6 }),
    ).toBe("oxagen · 6 files");
  });

  it("prefers the worktree over the project it was cut from", () => {
    // Two runs on the same project in different worktrees are different
    // runs, and the worktree is what says which.
    expect(
      deriveSessionTitle({
        projectDir: "/home/dev/oxagen",
        worktreePath: "/home/dev/oxagen-gateway",
        filesChanged: 2,
      }),
    ).toBe("oxagen-gateway · 2 files");
  });

  it("names a branch that says something, and omits one that does not", () => {
    expect(
      deriveSessionTitle({
        cwd: "/home/dev/oxagen",
        gitBranch: "agent/pensive-volta",
        filesChanged: 3,
      }),
    ).toBe("oxagen · agent/pensive-volta · 3 files");
    for (const gitBranch of ["main", "master", "HEAD"]) {
      expect(deriveSessionTitle({ cwd: "/home/dev/oxagen", gitBranch })).toBe(
        "oxagen",
      );
    }
  });

  it("counts commands when nothing was written, and says neither twice", () => {
    expect(
      deriveSessionTitle({ cwd: "/home/dev/oxagen", commandsRun: 12 }),
    ).toBe("oxagen · 12 commands");
    // Files are the more interesting fact, so they win rather than stacking.
    expect(
      deriveSessionTitle({
        cwd: "/home/dev/oxagen",
        filesChanged: 1,
        commandsRun: 12,
      }),
    ).toBe("oxagen · 1 file");
  });

  it("names a run that has only just started", () => {
    // The whole point: a name before the run finishes, where today a
    // sealed-only summariser leaves a uuid.
    expect(deriveSessionTitle({ cwd: "/home/dev/oxagen" })).toBe("oxagen");
  });

  it("answers undefined rather than inventing a name", () => {
    expect(deriveSessionTitle({})).toBeUndefined();
    expect(deriveSessionTitle({ cwd: "", projectDir: null })).toBeUndefined();
    expect(deriveSessionTitle({ cwd: "/" })).toBeUndefined();
  });

  it("keeps a title short enough to read in a list", () => {
    const title = deriveSessionTitle({
      cwd: `/home/dev/${"a".repeat(60)}`,
      gitBranch: `feature/${"b".repeat(60)}`,
      filesChanged: 4,
    });
    expect(title?.length).toBeLessThanOrEqual(80);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("ignores a trailing separator on a path", () => {
    expect(deriveSessionTitle({ cwd: "/home/dev/oxagen/" })).toBe("oxagen");
  });

  it("names a folder with no letter or digit by its parent too", () => {
    // A run in `~/Documents/_` was titled "_", which tells nobody where it
    // ran. The parent keeps the place readable and still names the folder.
    expect(deriveSessionTitle({ cwd: "/Users/dev/Documents/_" })).toBe(
      "Documents/_",
    );
    expect(deriveSessionTitle({ cwd: "C:\\Users\\dev\\notes\\--\\" })).toBe(
      "notes/--",
    );
    expect(deriveSessionTitle({ cwd: "/work/_/__" })).toBe("work/_/__");
    // Nothing above it to name: the folder is all there is.
    expect(deriveSessionTitle({ cwd: "/_" })).toBe("_");
  });
});
