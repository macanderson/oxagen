import { describe, expect, it } from "vitest";
import { assertCleanTree, releaseFilesToStage } from "./release";

const ROOT = "/repo";

describe("assertCleanTree", () => {
  it("passes on an empty status", () => {
    expect(() => assertCleanTree("")).not.toThrow();
    expect(() => assertCleanTree("\n")).not.toThrow();
  });

  it("throws on a modified tracked file and names it", () => {
    expect(() => assertCleanTree(" M foo\n")).toThrow(/uncommitted changes/);
    expect(() => assertCleanTree(" M foo\n")).toThrow(/\n {2}foo$/);
  });

  it("throws on an untracked file and names it", () => {
    expect(() => assertCleanTree("?? secret.env\n")).toThrow(/secret\.env/);
  });

  it("names every dirty path, staged ones included", () => {
    let message = "";
    try {
      assertCleanTree("M  staged.ts\n M edited.ts\n?? secret.env\n");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("  staged.ts");
    expect(message).toContain("  edited.ts");
    expect(message).toContain("  secret.env");
  });
});

describe("releaseFilesToStage", () => {
  it("stages exactly the files the release wrote, relative to the root", () => {
    const staged = releaseFilesToStage(ROOT, [
      "package.json",
      "apps/cli/package.json",
      `${ROOT}/releases/v1.2.3.md`,
      `${ROOT}/CHANGELOG.md`,
      `${ROOT}/apps/docs/content/docs/releases/v1.2.3.mdx`,
      `${ROOT}/apps/docs/content/docs/releases/meta.json`,
    ]);
    expect(staged).toEqual([
      "package.json",
      "apps/cli/package.json",
      "releases/v1.2.3.md",
      "CHANGELOG.md",
      "apps/docs/content/docs/releases/v1.2.3.mdx",
      "apps/docs/content/docs/releases/meta.json",
    ]);
  });

  it("never includes a file the release did not write", () => {
    const staged = releaseFilesToStage(`${ROOT}/`, [
      "package.json",
      `${ROOT}/CHANGELOG.md`,
    ]);
    expect(staged).not.toContain("secret.env");
    expect(staged).not.toContain(".");
    expect(staged).not.toContain("-A");
    expect(staged).toEqual(["package.json", "CHANGELOG.md"]);
  });

  it("lists each path once", () => {
    expect(
      releaseFilesToStage(ROOT, ["package.json", `${ROOT}/package.json`]),
    ).toEqual(["package.json"]);
  });
});
