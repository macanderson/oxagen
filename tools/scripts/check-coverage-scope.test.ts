/**
 * #3431: `@oxagen/app`'s coverage report counted about 80 files from the
 * retired app at 0% and failed its floor while every test passed. The guard
 * must fail on a report like that, and must not pass when there is no report
 * to read.
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

  it("fails on the retired app's files, the 2026-09-19 report", () => {
    // The witness: a file from apps/app_deprecated in apps/app's report.
    const foreign = `${CWD}/apps/app_deprecated/src/app/[orgSlug]/[workspaceSlug]/page.tsx`;
    const result = checkPackage("apps/app", io({ ...clean, [foreign]: entry }));
    expect(result.code).toBe(1);
    expect(result.message).toContain("1 outside apps/app/src");
    expect(result.message).toContain(foreign);
    expect(result.message).toContain("Do not lower a threshold");
  });

  it("fails on a file under src that is not on disk", () => {
    // The reported paths did not exist at the commit that was tested.
    const ghost = `${APP}/src/app/[orgSlug]/[workspaceSlug]/settings/page.tsx`;
    const result = checkPackage("apps/app", io({ ...clean, [ghost]: entry }));
    expect(result.code).toBe(1);
    expect(result.message).toContain("1 not on disk");
    expect(result.message).toContain(ghost);
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
