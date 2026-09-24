import { describe, expect, it } from "vitest";
import {
  buildVersion,
  MAX_BUILD_NUMBER,
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
