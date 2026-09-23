import { describe, expect, it } from "vitest";
import { deriveSessionTitle } from "./session-title";

describe("deriveSessionTitle", () => {
  it("leads with the place, because that is what tells two runs apart", () => {
    expect(
      deriveSessionTitle({ projectDir: "/home/dev/oxagen", filesChanged: 6 }),
    ).toBe("oxagen (6 files)");
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
    ).toBe("oxagen-gateway (2 files)");
  });

  it("names a branch that says something, and omits one that does not", () => {
    expect(
      deriveSessionTitle({
        cwd: "/home/dev/oxagen",
        gitBranch: "agent/pensive-volta",
        filesChanged: 3,
      }),
    ).toBe("oxagen on agent/pensive-volta (3 files)");
    for (const gitBranch of ["main", "master", "HEAD"]) {
      expect(deriveSessionTitle({ cwd: "/home/dev/oxagen", gitBranch })).toBe(
        "oxagen",
      );
    }
  });

  it("counts commands when nothing was written, and says neither twice", () => {
    expect(
      deriveSessionTitle({ cwd: "/home/dev/oxagen", commandsRun: 12 }),
    ).toBe("oxagen (12 commands)");
    // Files are the more interesting fact, so they win rather than stacking.
    expect(
      deriveSessionTitle({
        cwd: "/home/dev/oxagen",
        filesChanged: 1,
        commandsRun: 12,
      }),
    ).toBe("oxagen (1 file)");
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
    // The place and branch give way; the size is always read whole.
    expect(title).toMatch(/^a{60} on f[a-z]*… \(4 files\)$/);
    const bare = deriveSessionTitle({ cwd: `/home/dev/${"a".repeat(100)}` });
    expect(bare?.length).toBe(80);
    expect(bare?.endsWith("…")).toBe(true);
  });

  it("joins its parts as a phrase, with no separator characters", () => {
    const title = deriveSessionTitle({
      cwd: "/home/dev/oxagen",
      gitBranch: "agent/pensive-volta",
      commandsRun: 2,
    });
    expect(title).toBe("oxagen on agent/pensive-volta (2 commands)");
    expect(title).not.toMatch(/[·,]/);
    expect(deriveSessionTitle({ gitBranch: "agent/x", filesChanged: 1 })).toBe(
      "agent/x (1 file)",
    );
    expect(deriveSessionTitle({ filesChanged: 3 })).toBe("3 files");
  });

  it("never cuts a title between the halves of a surrogate pair", () => {
    // The cut falls at unit 79; the emoji's halves sit at 78 and 79.
    const title = deriveSessionTitle({
      cwd: `/home/dev/${"a".repeat(78)}😀${"a".repeat(10)}`,
    });
    expect(title).toBe(`${"a".repeat(78)}…`);
  });

  it("ignores a trailing separator on a path", () => {
    expect(deriveSessionTitle({ cwd: "/home/dev/oxagen/" })).toBe("oxagen");
  });
});
