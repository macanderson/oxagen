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
import { jobBlock, problems, steps } from "./check-checks-job-continues.mjs";

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
      found.some((p: string) => p.includes("chains pnpm commands with &&")),
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
          p.includes("chains pnpm commands with &&"),
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
        p.includes("chains pnpm commands with &&"),
      ),
    ).toBe(true);
  });

  it("reports a missing checks job instead of passing", () => {
    expect(problems("jobs:\n  build:\n    runs-on: x\n")).toEqual([
      "pipeline.yml has no `checks` job.",
    ]);
  });

  it("passes on the real pipeline.yml", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const yaml = readFileSync(
      join(here, "..", "..", ".github", "workflows", "pipeline.yml"),
      "utf8",
    );
    expect(problems(yaml)).toEqual([]);
  });
});
