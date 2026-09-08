import { describe, expect, it } from "vitest";
import {
  divergence,
  pinnedRef,
  RECHECK_EXCEPTIONS,
} from "./check-dod-stub-parity.mjs";

const PIN_A = "587435a133e3c8ac8fb6473ca5212939f5f064aa";
const PIN_B = "2dd72c9957f8520ee673862de894ed64f4b2380c";
const stub = (ref: string) =>
  `jobs:\n  dod:\n    uses: macanderson/oxagen/.github/workflows/dod-check.yml@${ref} # oxagen main\n`;

function world(over: Record<string, unknown> = {}) {
  return {
    stella: { checkSource: stub(PIN_A), recheckSha: "aaa" },
    arenabench: { checkSource: stub(PIN_A), recheckSha: "bbb" },
    "cgp-website": { checkSource: stub(PIN_A), recheckSha: "bbb" },
    "context-graph-protocol": { checkSource: stub(PIN_A), recheckSha: "bbb" },
    ...over,
  };
}

describe("pinnedRef", () => {
  it("reads the commit a stub pins", () => {
    expect(pinnedRef(stub(PIN_A))).toBe(PIN_A);
  });

  it("returns null for a moving ref, which is the thing ADR-045 forbids", () => {
    expect(
      pinnedRef(
        "uses: macanderson/oxagen/.github/workflows/dod-check.yml@main",
      ),
    ).toBeNull();
  });

  it("returns null when there is no uses: line at all", () => {
    expect(pinnedRef("name: dod-check\n")).toBeNull();
    expect(pinnedRef(undefined as never)).toBeNull();
  });
});

describe("divergence", () => {
  it("passes when every caller pins the same commit and the stubs match", () => {
    expect(divergence(world())).toEqual([]);
  });

  it("fails a partial re-pin, which is how a fix reaches three repos of four", () => {
    // Exactly #2551: the label existed everywhere and the pinned check ignored
    // it in four repos.
    const problems = divergence(
      world({ arenabench: { checkSource: stub(PIN_B), recheckSha: "bbb" } }),
    );
    expect(problems.join(" ")).toContain("pins disagree");
    expect(problems.join(" ")).toContain("arenabench");
  });

  it("fails a moving ref", () => {
    const problems = divergence(
      world({
        "cgp-website": {
          checkSource:
            "uses: macanderson/oxagen/.github/workflows/dod-check.yml@main",
          recheckSha: "bbb",
        },
      }),
    );
    expect(problems.join(" ")).toContain("pins no oxagen commit");
  });

  it("fails a recheck stub that differs from its siblings", () => {
    const problems = divergence(
      world({ "cgp-website": { checkSource: stub(PIN_A), recheckSha: "zzz" } }),
    );
    expect(problems.join(" ")).toContain("dod-recheck.yml differs");
  });

  it("fails a repo missing the recheck stub, whose issue edits re-run nothing", () => {
    const problems = divergence(
      world({ arenabench: { checkSource: stub(PIN_A), recheckSha: null } }),
    );
    expect(problems.join(" ")).toContain("is missing");
  });

  it("exempts stella's own implementation, and only stella's", () => {
    // stella's recheck sha is deliberately unlike the others above and the
    // clean case still passes; a second repo doing the same does not.
    expect(Object.keys(RECHECK_EXCEPTIONS)).toEqual(["stella"]);
    expect(divergence(world())).toEqual([]);
  });
});
