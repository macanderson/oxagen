import { describe, it, expect } from "vitest";
import { buildWorkspaceTools } from "./tools";
import { MemoryWorkspace } from "./workspaces/memory";
import {
  isTestPath,
  CANONICAL_TOOL_NAMES,
  canonicalToolName,
  modelToolName,
  scopeSchema,
  verbositySchema,
  limitSchema,
  resolveLimit,
  MUTATING_TOOL_NAMES,
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
    expect(canonicalToolName("read_file")).toBe("read_file");
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

describe("MUTATING_TOOL_NAMES", () => {
  it("names every filesystem mutator, deletion included", () => {
    // Moved here from loop-driver.test.ts with the list itself. The predicate
    // it used to test (`isMutatingTool`) went with the step loop — nothing
    // called it — so the set is asserted directly.
    //
    // `delete_file` belongs for the reason the set exists: a step that deleted
    // a file and then failed must not be blindly retried, and a deletion must
    // never be dispatched concurrently with a write to the same tree.
    expect([...MUTATING_TOOL_NAMES].sort()).toEqual([
      "bash",
      "delete_file",
      "edit_file",
      "write_file",
    ]);
  });

  it("excludes the read-only tools, which may run concurrently", () => {
    for (const readOnly of ["read_file", "list_dir", "search"]) {
      expect(MUTATING_TOOL_NAMES.has(readOnly)).toBe(false);
    }
  });

  it("is exactly the set of tools readOnly mode withholds", () => {
    // Derived from the registration rather than restated, and checked in BOTH
    // directions, because the two ways this list can be wrong have different
    // consequences and neither raises an error on its own. A name here that no
    // tool answers to serializes nothing. A registered mutator missing from
    // here is advertised to Stella as read_only and then dispatched
    // concurrently with a write — a data race with nothing to observe it.
    //
    // This guard exists because that second failure nearly shipped: the tool
    // surface gained `delete_file` in one branch while this list moved in
    // another, and the two merged cleanly with the deletion classified as a
    // read.
    const ws = () => new MemoryWorkspace({ "a.ts": "x" });
    const all = new Set(Object.keys(buildWorkspaceTools(ws())));
    const readOnly = new Set(
      Object.keys(buildWorkspaceTools(ws(), { readOnly: true })),
    );
    const withheld = [...all].filter((name) => !readOnly.has(name)).sort();
    expect(withheld).toEqual([...MUTATING_TOOL_NAMES].sort());
  });
});
