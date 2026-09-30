/**
 * #3431: a coverage report that names another package's files, or files not
 * on disk, fails a PR for a reason that is not true. The 2026-09-19 case
 * turned out to be a misread log, not such a report, but the guard must
 * still fail on one, and must not pass when there is no report to read.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPORT, checkPackage, offenders } from "./check-coverage-scope.mjs";

const CWD = "/w/oxagen";
const APP = `${CWD}/apps/app`;
const REPORT_PATH = `${APP}/${REPORT}`;

const entry = { s: {}, f: {}, b: {} };
const clean = {
  [`${APP}/src/ui/avatar.tsx`]: entry,
  [`${APP}/src/app/[org]/audit/page.tsx`]: entry,
};

function io(report: unknown, onDisk: string[] = Object.keys(clean)) {
  const files = new Map<string, string>();
  if (report !== undefined) {
    files.set(
      REPORT_PATH,
      typeof report === "string" ? report : JSON.stringify(report),
    );
  }
  return {
    cwd: CWD,
    read: (p: string) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT ${p}`);
      return c;
    },
    exists: (p: string) =>
      files.has(p) || onDisk.includes(p) || p === `${APP}/src`,
    realpath: (p: string) => p,
  };
}

describe("offenders", () => {
  it("accepts files under the package's src", () => {
    expect(offenders(clean, [`${APP}/src`], () => true)).toEqual({
      outside: [],
      missing: [],
      total: 2,
    });
  });

  it("does not take a sibling directory with the same prefix for src", () => {
    // `src-old` starts with `src`; a startsWith check would let it through.
    const report = { [`${APP}/src-old/a.ts`]: entry };
    expect(offenders(report, [`${APP}/src`], () => true).outside).toEqual([
      `${APP}/src-old/a.ts`,
    ]);
  });

  it("accepts a file reported under the realpath of src", () => {
    const report = { "/real/app/src/a.ts": entry };
    expect(
      offenders(report, [`${APP}/src`, "/real/app/src"], () => true).outside,
    ).toEqual([]);
  });
});

describe("checkPackage", () => {
  it("passes a report that names only the package's own source", () => {
    const result = checkPackage("apps/app", io(clean));
    expect(result.code).toBe(0);
    expect(result.message).toContain("names 2 files, all under apps/app/src");
  });

  it("fails on another package's files", () => {
    // The witness: a file from apps/app_deprecated in apps/app's report.
    const foreign = `${CWD}/apps/app_deprecated/src/app/[orgSlug]/[workspaceSlug]/page.tsx`;
    const result = checkPackage("apps/app", io({ ...clean, [foreign]: entry }));
    expect(result.code).toBe(1);
    expect(result.message).toContain("1 outside apps/app/src");
    expect(result.message).toContain(foreign);
    expect(result.message).toContain("Do not lower a threshold");
  });

  it("fails on a file under src that is not on disk", () => {
    const ghost = `${APP}/src/app/[orgSlug]/[workspaceSlug]/settings/page.tsx`;
    const result = checkPackage("apps/app", io({ ...clean, [ghost]: entry }));
    expect(result.code).toBe(1);
    expect(result.message).toContain("1 not on disk");
    expect(result.message).toContain(ghost);
  });

  it("reads a relative key against the package, not the process directory", () => {
    // #4664 item 10. The process runs from tools/scripts under vitest, so a
    // key resolved against process.cwd() would land outside apps/app/src.
    const relativeKeys = {
      "src/ui/avatar.tsx": entry,
      "src/app/[org]/audit/page.tsx": entry,
    };
    const result = checkPackage("apps/app", io(relativeKeys));
    expect(result.code).toBe(0);
    expect(result.message).toContain("names 2 files, all under apps/app/src");
    expect(
      offenders(relativeKeys, [`${APP}/src`], () => true, APP).outside,
    ).toEqual([]);
  });

  it("fails when there is no report, so it cannot pass empty", () => {
    const result = checkPackage("apps/app", io(undefined));
    expect(result.code).toBe(1);
    expect(result.message).toContain(
      "no report at apps/app/coverage/coverage-final.json",
    );
  });

  it("fails on a report that names no files", () => {
    const result = checkPackage("apps/app", io({}));
    expect(result.code).toBe(1);
    expect(result.message).toContain("names no files");
  });

  it("fails on a report that is not JSON", () => {
    const result = checkPackage("apps/app", io("{not json"));
    expect(result.code).toBe(1);
    expect(result.message).toContain("is not valid JSON");
  });

  it("caps the list at 20 files and says how many more", () => {
    const many: Record<string, unknown> = { ...clean };
    for (let i = 0; i < 25; i++) {
      many[`${CWD}/apps/app_deprecated/src/f${i}.ts`] = entry;
    }
    const result = checkPackage("apps/app", io(many));
    expect(result.message).toContain("25 outside apps/app/src");
    expect(result.message).toContain("and 5 more");
  });
});

describe("apps/app keeps the report this guard reads", () => {
  const config = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../apps/app/vitest.config.ts",
    ),
    "utf8",
  );

  it("pins the json reporter, the reports directory, and a report on failure", () => {
    expect(config).toMatch(/reporter:\s*\[[^\]]*"json"[^\]]*\]/);
    expect(config).toContain('reportsDirectory: "./coverage"');
    expect(config).toContain("reportOnFailure: true");
  });

  it("names the contamination as a cause distinct from the worker timeouts", () => {
    expect(config).toContain("#3431");
    expect(config).toContain("#3327");
  });

  it("keeps every threshold at 90", () => {
    const block = /thresholds:\s*\{([^}]*)\}/.exec(config)?.[1] ?? "";
    for (const metric of ["lines", "functions", "branches", "statements"]) {
      expect(block).toMatch(new RegExp(`${metric}:\\s*90\\b`));
    }
  });
});

describe("CI runs the guard", () => {
  const pipeline = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../.github/workflows/pipeline.yml",
    ),
    "utf8",
  );
  // The `unit` job: from its key to the next two-space job key, comments
  // dropped, so a comment naming the script cannot stand in for the step.
  const lines = pipeline.split("\n");
  const start = lines.indexOf("  unit:");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[A-Za-z][\w-]*:\s*$/.test(l));
  const unit = (end === -1 ? rest : rest.slice(0, end)).filter(
    (l) => !/^\s*#/.test(l),
  );

  const GUARD = "run: node tools/scripts/check-coverage-scope.mjs apps/app";
  const is = (text: string) => (l: string) => l.trim() === text;

  it("runs it in the app lane, after the thresholds, even when they fail", () => {
    expect(start).toBeGreaterThan(-1);
    const run = unit.findIndex(is(GUARD));
    expect(run).toBeGreaterThan(-1);
    const thresholds = unit.findIndex(is("- name: Coverage thresholds"));
    expect(thresholds).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(thresholds);
    // The step's own `if:` sits between its `- name:` and its `run:`.
    let stepStart = run;
    while (stepStart > 0 && !/^\s+- /.test(unit[stepStart] ?? "")) stepStart--;
    const condition = unit.slice(stepStart, run).join("\n");
    expect(condition).toContain("!cancelled()");
    expect(condition).toContain("matrix.lane == 'app'");
  });

  it("runs it only when the coverage suite itself ran (#4664 item 4)", () => {
    // When Bootstrap, Migrate or Seed fails, the suite never writes a report,
    // and a "no report" line beside the real cause points the reader away
    // from it. The thresholds step's own outcome gates the guard.
    const thresholds = unit.findIndex(is("- name: Coverage thresholds"));
    expect(unit[thresholds + 1]?.trim()).toBe("id: coverage");
    const run = unit.findIndex(is(GUARD));
    let stepStart = run;
    while (stepStart > 0 && !/^\s+- /.test(unit[stepStart] ?? "")) stepStart--;
    const condition = unit.slice(stepStart, run).join("\n");
    expect(condition).toContain(
      "(steps.coverage.outcome == 'success' || steps.coverage.outcome == 'failure')",
    );
  });
});
