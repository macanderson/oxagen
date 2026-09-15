// INV-20 (ARCHITECTURE.md §4, §6.3): `apps/app/e2e` holds exactly the rev1
// suite — `login.spec.ts`, `pay.spec.ts`, `page-load.spec.ts`, `routes.ts` and
// `support/` — and nothing else outside dot-entries (`.gitignore`, the runtime
// `.auth/` that login.spec.ts writes). No `*.spec.ts` sits under any other
// `apps/*/e2e` and no other `apps/*` carries a `playwright.config.ts`.
//
// WL-03 deleted the fixture-mode suite; WL-46 landed `login.spec.ts` and
// `support/`, so the suite directory exists and every entry is checked. The
// entries WL-47 (`page-load.spec.ts`, `routes.ts`) and WL-48 (`pay.spec.ts`)
// land are carried in baseline.json as `missing-entry` violations until they
// do; the baseline only shrinks. The route-set, catalog-key and
// `--pass-with-no-tests` clauses of INV-20 land with `routes.ts` (WL-47).
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_DIR, baselineEntries, describeDiff, diffBaseline } from "./parse";

const RULE = "e2e-files";
/** `apps/`, the directory INV-20 walks; every app but `app` is foreign to the suite. */
const APPS_DIR = path.resolve(APP_DIR, "..");
const SUITE_APP = "app";
const E2E_DIR = "e2e";
/** How the suite directory is spelled in a baseline entry. */
const SUITE_AT = "apps/app/e2e";

/** The top-level entries of `apps/app/e2e` once WL-46 lands them (§6.3). */
const REV1_E2E_ENTRIES: readonly string[] = [
  "login.spec.ts",
  "page-load.spec.ts",
  "pay.spec.ts",
  "routes.ts",
  "support",
];

/** Top-level entries of `abs` that do not start with `.`; an absent directory has none. */
function visibleEntries(abs: string): string[] {
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => !name.startsWith(".")).sort();
}

/** Whether any `*.spec.ts` sits anywhere under `abs`; an absent directory holds none. */
function hasSpec(abs: string): boolean {
  try {
    return readdirSync(abs, { recursive: true, withFileTypes: true }).some(
      (entry) => entry.isFile() && entry.name.endsWith(".spec.ts"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Violations for the suite directory at `abs`, reported as `at`: each entry
 * outside the rev1 set and each rev1 entry that is absent (an absent
 * directory is missing every entry).
 */
function suiteViolations(abs: string, at: string): string[] {
  const actual = visibleEntries(abs);
  return [
    ...actual
      .filter((name) => !REV1_E2E_ENTRIES.includes(name))
      .map((name) => `${RULE} ${at} unexpected-entry:${name}`),
    ...REV1_E2E_ENTRIES.filter((name) => !actual.includes(name)).map(
      (name) => `${RULE} ${at} missing-entry:${name}`,
    ),
  ];
}

/**
 * Violations across `appsDir`: every app other than `app` whose `e2e/` holds a
 * spec, and every such app that carries a `playwright.config.ts`; `at` is how
 * the directory is spelled in an entry (`apps` for the repo's own).
 */
function foreignViolations(appsDir: string, at: string): string[] {
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== SUITE_APP)
    .map((entry) => entry.name)
    .sort()
    .flatMap((app) => {
      const found: string[] = [];
      if (hasSpec(path.join(appsDir, app, E2E_DIR))) {
        found.push(`${RULE} ${at}/${app}/${E2E_DIR} spec-outside-apps-app`);
      }
      if (
        visibleEntries(path.join(appsDir, app)).includes("playwright.config.ts")
      ) {
        found.push(
          `${RULE} ${at}/${app}/playwright.config.ts playwright-config-outside-apps-app`,
        );
      }
      return found;
    });
}

// --- Tests ------------------------------------------------------------------

const PROBE_DIR = path.join(APP_DIR, "src/test/arch/probes/e2e-files");

describe("e2e files", () => {
  it("today's violations are exactly the baseline", () => {
    const actual = [
      ...suiteViolations(path.join(APP_DIR, E2E_DIR), SUITE_AT),
      ...foreignViolations(APPS_DIR, "apps"),
    ];
    const diff = diffBaseline(actual, baselineEntries([RULE]));
    expect(diff, describeDiff(diff, actual)).toEqual({
      unexpected: [],
      stale: [],
    });
  });

  it("an absent suite directory is missing every entry", () => {
    expect(suiteViolations(path.join(PROBE_DIR, "absent"), SUITE_AT)).toEqual(
      REV1_E2E_ENTRIES.map(
        (name) => `${RULE} ${SUITE_AT} missing-entry:${name}`,
      ),
    );
  });

  it("the rev1 entry set passes, dot-entries ignored", () => {
    expect(visibleEntries(path.join(PROBE_DIR, "ok"))).toEqual(
      REV1_E2E_ENTRIES,
    );
    expect(suiteViolations(path.join(PROBE_DIR, "ok"), SUITE_AT)).toEqual([]);
  });

  it("a probe named extra.spec.ts fails", () => {
    expect(suiteViolations(path.join(PROBE_DIR, "extra"), SUITE_AT)).toEqual([
      `${RULE} ${SUITE_AT} unexpected-entry:extra.spec.ts`,
    ]);
  });

  it("a partial suite fails on each missing entry", () => {
    expect(suiteViolations(path.join(PROBE_DIR, "missing"), SUITE_AT)).toEqual([
      `${RULE} ${SUITE_AT} missing-entry:page-load.spec.ts`,
      `${RULE} ${SUITE_AT} missing-entry:pay.spec.ts`,
      `${RULE} ${SUITE_AT} missing-entry:routes.ts`,
      `${RULE} ${SUITE_AT} missing-entry:support`,
    ]);
  });

  it("a spec or a playwright config under another app fails; apps/app and a spec-free e2e/ pass", () => {
    expect(foreignViolations(path.join(PROBE_DIR, "apps"), "probe")).toEqual([
      `${RULE} probe/other/${E2E_DIR} spec-outside-apps-app`,
      `${RULE} probe/other/playwright.config.ts playwright-config-outside-apps-app`,
    ]);
  });
});
