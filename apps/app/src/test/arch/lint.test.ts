// The lint half of the §4 invariants (ARCHITECTURE.md §4 preamble): every lint
// rule has a probe under probes/lint, linted through the ESLint Node API with
// the app's own eslint.config.mjs and `ignore: false`, as if it sat at `at`.
// The probe must produce the rule's error there, and nothing from that rule at
// a placement the rule exempts. Type-aware rules are switched off for the
// probe run: a probe is not in any tsconfig project, and no rule here needs
// type information.
import path from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { APP_DIR, listFiles, readSource, WHOLE_TREE_TIMEOUT_MS } from "./parse";

type Placement = { readonly at: string; readonly fails: boolean };
type Probe = {
  readonly rule: string;
  readonly placements: readonly Placement[];
};

const PROBE_DIR = "src/test/arch/probes/lint";
/** INV-02: the viewer seam and its test helper are the only exemptions. */
const VIEWER_SEAM: readonly Placement[] = [
  { at: "src/features/shell/probe.ts", fails: true },
  { at: "src/server/kernel.test.ts", fails: true },
  { at: "src/server/viewer.ts", fails: false },
  { at: "src/server/viewer.testing.ts", fails: false },
];
const PROBES: Readonly<Record<string, Probe>> = {
  "type-assertion.ts": {
    rule: "@typescript-eslint/consistent-type-assertions",
    placements: VIEWER_SEAM,
  },
  "object-assign.ts": {
    rule: "no-restricted-syntax",
    placements: VIEWER_SEAM,
  },
  "structured-clone.ts": {
    rule: "no-restricted-syntax",
    placements: VIEWER_SEAM,
  },
};

const eslint = new ESLint({
  cwd: APP_DIR,
  ignore: false,
  overrideConfig: tseslint.configs.disableTypeChecked,
});

describe("lint probes", () => {
  it("every probe file is placed", () => {
    expect(
      listFiles(PROBE_DIR).map((f) => f.slice(PROBE_DIR.length + 1)),
    ).toEqual(Object.keys(PROBES).sort());
  });

  for (const [probe, { rule, placements }] of Object.entries(PROBES)) {
    for (const { at, fails } of placements) {
      it(
        `${probe} at ${at} ${fails ? `fails ${rule}` : "passes"}`,
        async () => {
          const { text } = readSource(`${PROBE_DIR}/${probe}`);
          const [result] = await eslint.lintText(text, {
            filePath: path.join(APP_DIR, at),
          });
          const messages = result?.messages ?? [];
          expect(messages.filter((m) => m.fatal === true)).toEqual([]);
          expect(messages.some((m) => m.ruleId === rule)).toBe(fails);
        },
        WHOLE_TREE_TIMEOUT_MS,
      );
    }
  }
});
