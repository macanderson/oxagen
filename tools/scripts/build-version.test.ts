import { describe, expect, it } from "vitest";
import {
  buildVersion,
  compareVersions,
  MAX_BUILD_NUMBER,
  newestVersion,
  releaseCommitArgs,
} from "./lib/build-version";

describe("buildVersion", () => {
  it("leaves the release commit to its tag", () => {
    expect(buildVersion("2.1.1", 0)).toBeNull();
  });

  it("numbers every later commit as a build of the next patch", () => {
    expect(buildVersion("2.1.1", 1)).toBe("2.1.2-1");
    expect(buildVersion("2.1.1", 861)).toBe("2.1.2-861");
    expect(buildVersion("3.0.9", 12)).toBe("3.0.10-12");
  });

  it("stops at the largest number a Windows installer version holds", () => {
    expect(buildVersion("2.1.1", MAX_BUILD_NUMBER)).toBe(
      `2.1.2-${MAX_BUILD_NUMBER}`,
    );
    expect(() => buildVersion("2.1.1", MAX_BUILD_NUMBER + 1)).toThrow(
      /cut a release/,
    );
  });

  it("refuses what it cannot number", () => {
    expect(() => buildVersion("2.1", 3)).toThrow(/not a release version/);
    expect(() => buildVersion("2.1.2-4", 3)).toThrow(/not a release version/);
    expect(() => buildVersion("2.1.1", -1)).toThrow(/whole number/);
    expect(() => buildVersion("2.1.1", 1.5)).toThrow(/whole number/);
  });
});

describe("releaseCommitArgs", () => {
  it("finds the commit that added the root version line", () => {
    expect(releaseCommitArgs("2.1.1")).toEqual([
      "log",
      "-1",
      "--format=%H",
      '-S"version": "2.1.1"',
      "--",
      "package.json",
    ]);
  });
});

describe("compareVersions", () => {
  it("orders releases by their numbers", () => {
    expect(compareVersions("2.1.3", "2.1.2")).toBeGreaterThan(0);
    expect(compareVersions("2.1.3", "2.2.0")).toBeLessThan(0);
    expect(compareVersions("10.0.0", "9.9.9")).toBeGreaterThan(0);
    expect(compareVersions("2.1.3", "2.1.3")).toBe(0);
  });

  it("puts a build after the release before it and before the one it leads to", () => {
    expect(compareVersions("2.1.4-1", "2.1.3")).toBeGreaterThan(0);
    expect(compareVersions("2.1.4-861", "2.1.4")).toBeLessThan(0);
    expect(compareVersions("2.1.4", "2.1.4-861")).toBeGreaterThan(0);
  });

  it("orders builds by their number, not as text", () => {
    expect(compareVersions("2.1.4-10", "2.1.4-9")).toBeGreaterThan(0);
    expect(compareVersions("2.1.4-9", "2.1.4-9")).toBe(0);
  });

  it("refuses a version it cannot order", () => {
    expect(() => compareVersions("1.0.0-beta.1", "1.0.0")).toThrow(
      /neither a release nor a build/,
    );
    expect(() => compareVersions("2.1.4", "v2.1.4")).toThrow();
  });
});

describe("newestVersion", () => {
  it("finds the newest release or build", () => {
    expect(newestVersion(["1.0.1", "2.1.4-3", "2.1.3", "0.7.0"])).toBe(
      "2.1.4-3",
    );
    expect(newestVersion(["2.1.4-3", "2.1.4"])).toBe("2.1.4");
  });

  it("leaves out versions of any other shape", () => {
    expect(newestVersion(["1.0.0", "9.0.0-beta.1"])).toBe("1.0.0");
  });

  it("answers null when nothing can be ordered", () => {
    expect(newestVersion([])).toBeNull();
    expect(newestVersion(["9.0.0-beta.1"])).toBeNull();
  });
});
