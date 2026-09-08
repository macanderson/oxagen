import { describe, expect, it } from "vitest";
import { inspect, verdict } from "./check-coverage-gates.mjs";

/** A tiny fake filesystem, so the guard is driven rather than described. */
function fs(files: Record<string, string>) {
  return {
    read: (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    exists: (p: string) => p in files,
  };
}

const WITH_THRESHOLDS =
  "export default { test: { coverage: { thresholds: { lines: 90 } } } };";
const NO_THRESHOLDS = "export default { test: {} };";

function pkg(scripts: object, dev: object) {
  return JSON.stringify({ name: "@oxagen/x", scripts, devDependencies: dev });
}

describe("a declared threshold must have a task that can fail it (#2635)", () => {
  it("fails a package that declares thresholds and has no test:coverage script", () => {
    // This is `@oxagen/tenancy` exactly: four numbers nothing read.
    const f = fs({
      "p/package.json": pkg({ "test:unit": "vitest run" }, {}),
      "p/vitest.config.ts": WITH_THRESHOLDS,
    });
    const v = verdict(inspect("p", f.read as never, f.exists as never));
    expect(v).not.toBeNull();
    expect(v!.missing.join(" ")).toContain("test:coverage");
    expect(v!.missing.join(" ")).toContain("@vitest/coverage-v8");
  });

  it("fails a package that has the script but not the provider", () => {
    // `apps/mcp` was the other direction: provider present, no script.
    const f = fs({
      "p/package.json": pkg({ "test:coverage": "vitest run --coverage" }, {}),
      "p/vitest.config.ts": WITH_THRESHOLDS,
    });
    const v = verdict(inspect("p", f.read as never, f.exists as never));
    expect(v!.missing).toHaveLength(1);
    expect(v!.missing[0]).toContain("@vitest/coverage-v8");
  });

  it("passes a package with all three", () => {
    const f = fs({
      "p/package.json": pkg(
        { "test:coverage": "vitest run --coverage" },
        { "@vitest/coverage-v8": "2.1.9" },
      ),
      "p/vitest.config.ts": WITH_THRESHOLDS,
    });
    expect(
      verdict(inspect("p", f.read as never, f.exists as never)),
    ).toBeNull();
  });

  it("says nothing about a package that declares no thresholds", () => {
    // Not gating on coverage is a choice, and this guard has no opinion on it.
    const f = fs({
      "p/package.json": pkg({ "test:unit": "vitest run" }, {}),
      "p/vitest.config.ts": NO_THRESHOLDS,
    });
    expect(
      verdict(inspect("p", f.read as never, f.exists as never)),
    ).toBeNull();
  });

  it("still fails a test:coverage script with no provider, thresholds or not", () => {
    // The script would exit non-zero on a missing provider, which reads as a
    // failing gate rather than an unrunnable one. Catch it here instead.
    const f = fs({
      "p/package.json": pkg({ "test:coverage": "vitest run --coverage" }, {}),
      "p/vitest.config.ts": NO_THRESHOLDS,
    });
    expect(
      verdict(inspect("p", f.read as never, f.exists as never))!.missing[0],
    ).toContain("@vitest/coverage-v8");
  });

  it("ignores a directory with no package.json", () => {
    expect(
      inspect("p", fs({}).read as never, fs({}).exists as never),
    ).toBeNull();
    expect(verdict(null)).toBeNull();
  });

  it("ignores a package.json that does not parse, rather than crashing the run", () => {
    const f = fs({ "p/package.json": "{ not json" });
    expect(inspect("p", f.read as never, f.exists as never)).toBeNull();
  });
});
