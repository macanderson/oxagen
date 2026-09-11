import { describe, expect, it } from "vitest";
import {
  divergence,
  pinnedRef,
  RECHECK_EXCEPTIONS,
} from "./check-dod-stub-parity.mjs";

const PIN_A = "587435a133e3c8ac8fb6473ca5212939f5f064aa";
const PIN_B = "2dd72c9957f8520ee673862de894ed64f4b2380c";
const PIN_C = "84fe021ba3cf455b1d5057b04ed1111152fdceda";
const stub = (ref: string) =>
  `jobs:\n  dod:\n    uses: macanderson/oxagen/.github/workflows/dod-check.yml@${ref} # oxagen main\n`;
const guardStub = (ref: string) =>
  `jobs:\n  guard:\n    uses: macanderson/oxagen/.github/workflows/dod-close-guard.yml@${ref} # last changed 2026-09-05\n`;

/**
 * One repo's facts, healthy by default so a test states only what it breaks.
 *
 * `guardBlob` defaults to the same value everywhere because that is the real
 * world: stella pins a different close-guard commit from the other three and
 * the two resolve to identical bytes, so the healthy case has disagreeing pins
 * and one blob.
 */
const repo = (over: Record<string, unknown> = {}) => ({
  checkSource: stub(PIN_A),
  recheckSha: "bbb",
  closeGuardSource: guardStub(PIN_C),
  closeGuardBlob: "ca5c8e49",
  ...over,
});

function world(over: Record<string, unknown> = {}) {
  return {
    stella: repo({ recheckSha: "aaa", closeGuardSource: guardStub(PIN_B) }),
    arenabench: repo(),
    "cgp-website": repo(),
    "context-graph-protocol": repo(),
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
      world({ arenabench: repo({ checkSource: stub(PIN_B) }) }),
    );
    expect(problems.join(" ")).toContain("pins disagree");
    expect(problems.join(" ")).toContain("arenabench");
  });

  it("fails a moving ref", () => {
    const problems = divergence(
      world({
        "cgp-website": repo({
          checkSource:
            "uses: macanderson/oxagen/.github/workflows/dod-check.yml@main",
        }),
      }),
    );
    expect(problems.join(" ")).toContain("pins no oxagen commit");
  });

  it("fails a recheck stub that differs from its siblings", () => {
    const problems = divergence(
      world({ "cgp-website": repo({ recheckSha: "zzz" }) }),
    );
    expect(problems.join(" ")).toContain("dod-recheck.yml differs");
  });

  it("fails a repo missing the recheck stub, whose issue edits re-run nothing", () => {
    const problems = divergence(
      world({ arenabench: repo({ recheckSha: null }) }),
    );
    expect(problems.join(" ")).toContain("is missing");
  });

  // #1336: three of four callers sat on `@main` for this stub and this script
  // never looked at it. These are the cases that would have said so.
  it("fails a moving ref on the close guard, the stub carrying issues: write", () => {
    const problems = divergence(
      world({
        arenabench: repo({
          closeGuardSource:
            "uses: macanderson/oxagen/.github/workflows/dod-close-guard.yml@main",
        }),
      }),
    );
    expect(problems.join(" ")).toContain("dod-close-guard.yml pins no oxagen");
    expect(problems.join(" ")).toContain("arenabench");
  });

  it("fails a repo with no close guard at all", () => {
    const problems = divergence(
      world({ "cgp-website": repo({ closeGuardSource: "" }) }),
    );
    expect(problems.join(" ")).toContain("dod-close-guard.yml is missing");
  });

  it("accepts close-guard pins that differ but resolve to the same file", () => {
    // The state on 2026-09-11: stella names 2b61b052, the rest name 84fe021b,
    // and the second commit did not change the file. Comparing ref strings
    // would call that drift; it is not.
    expect(divergence(world())).toEqual([]);
  });

  it("fails close-guard pins that resolve to different files", () => {
    const problems = divergence(
      world({ stella: repo({ closeGuardBlob: "deadbeef" }) }),
    );
    expect(problems.join(" ")).toContain("resolve to different files");
    expect(problems.join(" ")).toContain("stella");
  });

  it("fails a close-guard pin that no longer resolves", () => {
    const problems = divergence(
      world({ arenabench: repo({ closeGuardBlob: null }) }),
    );
    expect(problems.join(" ")).toContain("no longer resolves");
  });

  it("exempts stella's own implementation, and only stella's", () => {
    // stella's recheck sha is deliberately unlike the others above and the
    // clean case still passes; a second repo doing the same does not.
    expect(Object.keys(RECHECK_EXCEPTIONS)).toEqual(["stella"]);
    expect(divergence(world())).toEqual([]);
  });
});
