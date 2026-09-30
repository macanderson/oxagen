/**
 * The guard for #3428: the `checks` job reports every failure in one run.
 *
 * BEFORE is the shape that shipped until 2026-09-28: turbo without
 * `--continue`, eight checks chained with `&&`, and later steps on the default
 * `success()`. PR #3385 paid three CI cycles for three failures under it. The
 * guard must reject it and accept AFTER, and the real pipeline.yml must pass.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  chainedScripts,
  jobBlock,
  problems,
  scriptsRunBy,
  steps,
} from "./check-checks-job-continues.mjs";

const IF = "${{ !cancelled() && steps.install.outcome == 'success' }}";

const BEFORE = `jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - uses: ./.github/actions/pnpm-install

      - name: Lint and typecheck
        run: |
          set -f
          pnpm turbo run lint typecheck --concurrency=3 $TURBO_FILTER

      - name: knip production mode (apps/app)
        run: pnpm --filter @oxagen/app exec knip --production --strict

      - name: Manifest, contracts, env invariants
        env:
          DB_LINT_HEAD_REF: x
        run: pnpm check:manifest && pnpm check:contracts && pnpm env:check

      - name: File Linear tickets for manifest gaps
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        run: pnpm check:manifest:tickets

  build:
    runs-on: ubuntu-latest
`;

const AFTER = `jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      # A comment that quotes the old shape must not trip the guard:
      # run: pnpm check:manifest && pnpm check:contracts
      - uses: ./.github/actions/pnpm-install
        id: install

      - name: Lint and typecheck
        run: |
          set -f
          # the old call, quoted: pnpm turbo run lint typecheck $TURBO_FILTER
          pnpm turbo run lint typecheck --concurrency=3 --continue $TURBO_FILTER

      - name: knip production mode (apps/app)
        if: ${IF}
        run: pnpm --filter @oxagen/app exec knip --production --strict

      - name: Manifest, contracts, env invariants
        if: ${IF}
        env:
          DB_LINT_HEAD_REF: x
        run: >-
          node tools/scripts/run-checks.mjs
          check:manifest
          check:contracts

      - name: File Linear tickets for manifest gaps
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        run: pnpm check:manifest:tickets

  build:
    runs-on: ubuntu-latest
`;

describe("steps", () => {
  it("reads the checks job's steps and stops at the next job", () => {
    const list = steps(jobBlock(AFTER, "checks"));
    expect(
      list.map(
        (s: { name: string | null; uses: string | null }) => s.name ?? s.uses,
      ),
    ).toEqual([
      "actions/checkout@v5",
      "./.github/actions/pnpm-install",
      "Lint and typecheck",
      "knip production mode (apps/app)",
      "Manifest, contracts, env invariants",
      "File Linear tickets for manifest gaps",
    ]);
    expect(list[1]?.id).toBe("install");
    expect(list[4]?.if).toBe(IF);
  });
});

describe("problems", () => {
  it("rejects the shape that stopped at the first failure", () => {
    const found = problems(BEFORE);
    expect(found.some((p: string) => p.includes("without --continue"))).toBe(
      true,
    );
    expect(
      found.some((p: string) => p.includes("chains commands with &&")),
    ).toBe(true);
    expect(found.some((p: string) => p.includes("id: install"))).toBe(true);
    expect(
      found.some((p: string) =>
        p.startsWith('"knip production mode (apps/app)" needs if:'),
      ),
    ).toBe(true);
    // The Linear step is exempt, so it is never reported.
    expect(found.some((p: string) => p.includes("File Linear tickets"))).toBe(
      false,
    );
  });

  it("accepts the shape that runs every check to the end", () => {
    expect(problems(AFTER)).toEqual([]);
  });

  it("rejects a later step that fell back to always(), which runs after a failed install", () => {
    const always = AFTER.replace(
      `      - name: knip production mode (apps/app)\n        if: ${IF}`,
      "      - name: knip production mode (apps/app)\n        if: always()",
    );
    expect(problems(always)).toEqual([
      `"knip production mode (apps/app)" needs if: ${IF}, so it runs after an earlier check fails and not after a failed install.`,
    ]);
  });

  it("rejects a chain split across lines of a literal block", () => {
    // `pnpm a &&` ending one line and `pnpm b` on the next is still one
    // shell list, and so is a backslash line break.
    for (const joiner of [" &&\n          ", " && \\\n          "]) {
      const split = AFTER.replace(
        "        run: pnpm --filter @oxagen/app exec knip --production --strict",
        `        run: |\n          pnpm check:manifest${joiner}pnpm check:contracts`,
      );
      expect(
        problems(split).some((p: string) =>
          p.includes("chains commands with &&"),
        ),
      ).toBe(true);
    }
  });

  it("rejects a chain folded across lines of a > block", () => {
    // YAML folds `>-` lines into one shell line, so these two lines are
    // `pnpm check:manifest && pnpm check:contracts`.
    const folded = AFTER.replace(
      "        run: pnpm --filter @oxagen/app exec knip --production --strict",
      "        run: >-\n          pnpm check:manifest &&\n          pnpm check:contracts",
    );
    expect(
      problems(folded).some((p: string) =>
        p.includes("chains commands with &&"),
      ),
    ).toBe(true);
  });

  it("rejects a node chain as well as a pnpm one", () => {
    const chained = AFTER.replace(
      "        run: pnpm --filter @oxagen/app exec knip --production --strict",
      "        run: node tools/scripts/a.mjs && node tools/scripts/b.mjs",
    );
    expect(
      problems(chained).some((p: string) =>
        p.includes("chains commands with &&"),
      ),
    ).toBe(true);
  });

  it("rejects two commands on separate lines of a literal block", () => {
    // GitHub runs `run:` under bash -e, so the first failing line ends the
    // block exactly as && would (#4664 item 9).
    const block = AFTER.replace(
      "        run: pnpm --filter @oxagen/app exec knip --production --strict",
      "        run: |\n          pnpm check:manifest\n          node tools/scripts/check-adr-index.mjs",
    );
    expect(problems(block)).toEqual([
      '"knip production mode (apps/app)" runs 2 commands on separate lines under bash -e, so the first failure hides the rest. Use tools/scripts/run-checks.mjs.',
    ]);
    // A block that turns -e off handles the statuses itself.
    const handled = block.replace(
      "        run: |\n          pnpm check:manifest\n",
      "        run: |\n          set +e\n          pnpm check:manifest\n",
    );
    expect(problems(handled)).toEqual([]);
  });

  it("rejects a root script the job runs that chains its commands", () => {
    // The shape check:contracts had until #4664 item 9: the step's runner
    // reports each script, but inside check:contracts the first failing
    // guard still hid every guard after it.
    const chained = {
      "check:manifest": "node tools/scripts/check_manifest.mjs",
      "check:contracts": "node tools/scripts/a.mjs && node tools/scripts/b.mjs",
    };
    expect(problems(AFTER, chained)).toEqual([
      "pnpm check:contracts chains commands with &&, so its first failing command hides the rest. Make each command a root script and list them in a tools/scripts/run-checks.mjs call.",
    ]);
    const listed = {
      "check:manifest": "node tools/scripts/check_manifest.mjs",
      "check:contracts": "node tools/scripts/run-checks.mjs check:a check:b",
      "check:a": "node tools/scripts/a.mjs",
      "check:b": "node tools/scripts/b.mjs",
    };
    expect(problems(AFTER, listed)).toEqual([]);
  });

  it("reports a missing checks job instead of passing", () => {
    expect(problems("jobs:\n  build:\n    runs-on: x\n")).toEqual([
      "pipeline.yml has no `checks` job.",
    ]);
  });

  it("passes on the real pipeline.yml and package.json", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const yaml = readFileSync(
      join(here, "..", "..", ".github", "workflows", "pipeline.yml"),
      "utf8",
    );
    const { scripts } = JSON.parse(
      readFileSync(join(here, "..", "..", "package.json"), "utf8"),
    );
    expect(problems(yaml, scripts)).toEqual([]);
    // The walk reaches check:contracts' guards, so the pass above covers them.
    const job = steps(jobBlock(yaml, "checks") ?? "");
    const named = job.flatMap((s: { run: string | null }) =>
      scriptsRunBy(s.run ?? "", scripts),
    );
    expect(named).toContain("check:contracts");
    expect(scriptsRunBy(scripts["check:contracts"], scripts)).toContain(
      "check:role-enforcement",
    );
  });
});

describe("chainedScripts", () => {
  it("follows run-checks lists and pnpm calls, once each", () => {
    const scripts = {
      outer: "node tools/scripts/run-checks.mjs inner single",
      inner: "node tools/scripts/run-checks.mjs deep outer",
      single: "pnpm deep",
      deep: "tsx one.ts && tsx two.ts",
    };
    expect(chainedScripts(["outer"], scripts)).toEqual(["deep"]);
    // A name with no root script is run-checks' own failure to report.
    expect(chainedScripts(["missing"], scripts)).toEqual([]);
    expect(scriptsRunBy("node x/run-checks.mjs inner && pnpm run single", scripts)).toEqual([
      "inner",
      "single",
    ]);
  });
});
