import { describe, it, expect } from "vitest";
import {
  PACKAGE_MANAGERS,
  isValidPackageToken,
  managersForImage,
  parsePackageTokens,
  runtimesForImage,
} from "./sandbox-runtimes";

describe("runtimesForImage / managersForImage", () => {
  it("maps node to npm + apt and Node.js 20", () => {
    expect(runtimesForImage("node")).toEqual([
      { name: "Node.js", version: "20" },
    ]);
    expect(managersForImage("node").map((m) => m.id)).toEqual(["npm", "apt"]);
  });

  it("maps python and agent to pip + apt", () => {
    expect(managersForImage("python").map((m) => m.id)).toEqual(["pip", "apt"]);
    expect(managersForImage("agent").map((m) => m.id)).toEqual(["pip", "apt"]);
  });

  it("gives a shell base apt only", () => {
    expect(managersForImage("shell").map((m) => m.id)).toEqual(["apt"]);
  });

  it("falls back to the apt-only profile for an unknown image", () => {
    expect(managersForImage("mystery").map((m) => m.id)).toEqual(["apt"]);
    expect(runtimesForImage("mystery")).toEqual(runtimesForImage("shell"));
  });
});

describe("install command composition", () => {
  it("builds the right install command per manager", () => {
    expect(PACKAGE_MANAGERS.npm.install(["express", "zod"])).toBe(
      "npm install express zod",
    );
    expect(PACKAGE_MANAGERS.pip.install(["requests"])).toBe(
      "pip install requests",
    );
    expect(PACKAGE_MANAGERS.apt.install(["jq"])).toBe(
      "apt-get update && apt-get install -y jq",
    );
  });

  it("interpolates a version pin unquoted (documents the redirect defect)", () => {
    // Pinned in a test so the defect is visible rather than folklore: the shell
    // reads `>=2` as a redirect into a file named `=2` and pip installs bare
    // `requests`. When install() starts single-quoting tokens, this expectation
    // flips to "pip install 'requests>=2'".
    expect(PACKAGE_MANAGERS.pip.install(["requests>=2"])).toBe(
      "pip install requests>=2",
    );
  });
});

describe("isValidPackageToken", () => {
  it("accepts real ecosystem names, scopes, and version pins", () => {
    for (const ok of [
      "express",
      "@tanstack/react-query",
      "typescript@5.4.0",
      "pydantic==2.5",
      "requests>=2",
      "left-pad",
      "some.dotted.pkg",
    ]) {
      expect(isValidPackageToken(ok)).toBe(true);
    }
  });

  it("rejects shell-active or empty tokens", () => {
    for (const bad of [
      "",
      "express; rm -rf /",
      "foo && bar",
      "$(whoami)",
      "`id`",
      "a b",
      "pkg|tee",
      "x".repeat(300),
    ]) {
      expect(isValidPackageToken(bad)).toBe(false);
    }
  });
});

describe("parsePackageTokens", () => {
  it("splits on whitespace and commas and de-dupes, preserving order", () => {
    expect(parsePackageTokens("express, zod  express\nfastapi")).toEqual([
      "express",
      "zod",
      "fastapi",
    ]);
  });

  it("returns an empty list for blank input", () => {
    expect(parsePackageTokens("   \n , ")).toEqual([]);
  });
});
