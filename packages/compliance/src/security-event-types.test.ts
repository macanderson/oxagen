/**
 * #2528: the taxonomy declares types nothing writes, and an audit filter that
 * offers one returns zero rows — indistinguishable from "this never happened".
 *
 * The module's own note says the RESERVED markers are HAND-MAINTAINED and that
 * "no test asserts that an unmarked value has a live emitter, so a type can
 * lose its last emitter and keep reading as covered." This file is that test.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  EMITTED_SECURITY_EVENT_TYPES,
  RESERVED_SECURITY_EVENT_TYPES,
  SECURITY_EVENT_TYPES,
  isEmittedSecurityEventType,
} from "./security-event-types";

/**
 * The repository root. vitest runs with the PACKAGE as its cwd, so a search
 * for `packages`/`apps` from there matches nothing and every type would look
 * orphaned — a scan that cannot see the tree it is judging.
 */
const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

/**
 * Production files that mention the literal.
 *
 * Tests are excluded, and that distinction is the point: a test asserting a
 * type is NOT offered mentions the literal without emitting it, so counting
 * tests would let a type look covered because something checks it is absent.
 * An emitter is shipping code.
 */
function referencesOutsideTaxonomy(type: string): string[] {
  let out = "";
  try {
    out = execFileSync(
      "git",
      [
        "grep",
        "-l",
        "--fixed-strings",
        `"${type}"`,
        "--",
        "packages",
        "apps",
        // Exclude every test file: see the note above.
        ":(exclude)**/*.test.ts",
        ":(exclude)**/*.test.tsx",
        ":(exclude)**/__tests__/**",
      ],
      { encoding: "utf8", cwd: REPO_ROOT },
    );
  } catch {
    // git grep exits 1 when nothing matches.
    return [];
  }
  return out
    .split("\n")
    .filter((f) => f !== "" && !f.includes("security-event-types"));
}

describe("the emitted subset", () => {
  it("is the full union minus the reserved list, with no third copy to drift", () => {
    expect(new Set(EMITTED_SECURITY_EVENT_TYPES)).toEqual(
      new Set(
        SECURITY_EVENT_TYPES.filter(
          (t) => !RESERVED_SECURITY_EVENT_TYPES.includes(t as never),
        ),
      ),
    );
    expect(
      EMITTED_SECURITY_EVENT_TYPES.length +
        RESERVED_SECURITY_EVENT_TYPES.length,
    ).toBe(SECURITY_EVENT_TYPES.length);
  });

  it("excludes every reserved type", () => {
    for (const type of RESERVED_SECURITY_EVENT_TYPES) {
      expect(EMITTED_SECURITY_EVENT_TYPES, type).not.toContain(type);
      expect(isEmittedSecurityEventType(type), type).toBe(false);
    }
  });

  it("keeps the full union intact for the DB CHECK and historical rows", () => {
    // Narrowing what a UI offers must never narrow what the column accepts.
    for (const type of RESERVED_SECURITY_EVENT_TYPES) {
      expect(SECURITY_EVENT_TYPES).toContain(type);
    }
  });

  it("names the eight the audit found", () => {
    expect(RESERVED_SECURITY_EVENT_TYPES).toHaveLength(8);
  });
});

/**
 * The markers are only worth anything if they are true. These fail in BOTH
 * directions, which is what the module's note asks for: a reserved type that
 * gained an emitter is a stale marker, and a non-reserved type that lost its
 * last one is a type quietly reading as covered.
 */
describe("the RESERVED markers match the repository", () => {
  it("finds no emitter for any reserved type", () => {
    const stale = RESERVED_SECURITY_EVENT_TYPES.filter(
      (t) => referencesOutsideTaxonomy(t).length > 0,
    );
    expect(
      stale,
      `these are marked RESERVED but something now references them — ` +
        `move them into the emitted set: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("finds a reference for every emitted type", () => {
    const orphaned = EMITTED_SECURITY_EVENT_TYPES.filter(
      (t) => referencesOutsideTaxonomy(t).length === 0,
    );
    expect(
      orphaned,
      `these are offered as filterable but nothing references them — ` +
        `mark them RESERVED: ${orphaned.join(", ")}`,
    ).toEqual([]);
  });
});
