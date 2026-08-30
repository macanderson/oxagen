import { describe, it, expect } from "vitest";
import {
  isTestPath,
  CANONICAL_TOOL_NAMES,
  canonicalToolName,
  modelToolName,
  scopeSchema,
  verbositySchema,
  limitSchema,
  resolveLimit,
} from "./tools-shared";

describe("isTestPath", () => {
  it("matches test directories and filename conventions", () => {
    expect(isTestPath("src/__tests__/a.ts")).toBe(true);
    expect(isTestPath("pkg/a.test.ts")).toBe(true);
    expect(isTestPath("pkg/a_spec.rb")).toBe(true);
    expect(isTestPath("tests/thing.py")).toBe(true);
  });
  it("does not match ordinary source files", () => {
    expect(isTestPath("src/a.ts")).toBe(false);
    expect(isTestPath("src/latest.ts")).toBe(false);
  });
});

describe("tool naming standard", () => {
  it("maps every canonical name to a model-facing name by dots→underscores", () => {
    for (const name of CANONICAL_TOOL_NAMES) {
      expect(modelToolName(name)).toBe(name.replace(/\./g, "_"));
    }
  });

  it("modelToolName matches the kernel's charset sanitization (^[A-Za-z0-9_-])", () => {
    expect(modelToolName("test.unit.run")).toBe("test_unit_run");
    expect(modelToolName("build.package.run")).toBe("build_package_run");
  });

  it("canonicalToolName round-trips a model-facing name back to canonical", () => {
    for (const name of CANONICAL_TOOL_NAMES) {
      expect(canonicalToolName(modelToolName(name))).toBe(name);
    }
  });

  it("returns an already-canonical name unchanged", () => {
    expect(canonicalToolName("test.unit.run")).toBe("test.unit.run");
  });

  it("returns an unknown/legacy name unchanged (training-prior tools are not renamed)", () => {
    expect(canonicalToolName("read_file")).toBe("read_file");
    expect(canonicalToolName("code_graph")).toBe("code_graph");
  });
});

describe("scopeSchema (exactly-one refinement)", () => {
  it("accepts exactly one of package / files / all", () => {
    expect(scopeSchema.safeParse({ package: "@oxagen/x" }).success).toBe(true);
    expect(scopeSchema.safeParse({ files: ["a.ts"] }).success).toBe(true);
    expect(scopeSchema.safeParse({ all: true }).success).toBe(true);
  });
  it("rejects no scope and multiple scopes", () => {
    expect(scopeSchema.safeParse({}).success).toBe(false);
    expect(
      scopeSchema.safeParse({ package: "x", files: ["a.ts"] }).success,
    ).toBe(false);
    expect(scopeSchema.safeParse({ package: "x", all: true }).success).toBe(
      false,
    );
  });
  it("treats all:false as not-a-scope (so it fails the exactly-one rule)", () => {
    expect(scopeSchema.safeParse({ all: false }).success).toBe(false);
  });
});

describe("verbositySchema", () => {
  it("defaults to minimal", () => {
    expect(verbositySchema.parse(undefined)).toBe("minimal");
  });
  it("accepts the three levels and rejects others", () => {
    expect(verbositySchema.parse("verbose")).toBe("verbose");
    expect(verbositySchema.safeParse("chatty").success).toBe(false);
  });
});

describe("limitSchema + resolveLimit", () => {
  const caps = { minimal: 5, standard: 15, verbose: 40 };
  it("limitSchema bounds to [1, hardMax] and is optional", () => {
    const s = limitSchema(40);
    expect(s.safeParse(undefined).success).toBe(true);
    expect(s.safeParse(41).success).toBe(false);
    expect(s.safeParse(0).success).toBe(false);
    expect(s.safeParse(10).success).toBe(true);
  });
  it("resolveLimit picks the verbosity ceiling when no explicit limit", () => {
    expect(resolveLimit("minimal", caps)).toBe(5);
    expect(resolveLimit("standard", caps)).toBe(15);
    expect(resolveLimit("verbose", caps)).toBe(40);
  });
  it("resolveLimit honors an explicit limit but clamps to the verbose ceiling", () => {
    expect(resolveLimit("minimal", caps, 3)).toBe(3);
    expect(resolveLimit("minimal", caps, 100)).toBe(40); // clamped
    expect(resolveLimit("minimal", caps, 0)).toBe(1); // floored
  });
});
