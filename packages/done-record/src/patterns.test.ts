// patterns.test.ts: the handle, digest, id, and time shapes, and checkKind.
import { describe, expect, it } from "vitest";
import {
  ACTOR_MAX_LENGTH,
  CRITERION_ID_PATTERN,
  LINEAGE_PATTERN,
  TRIAGE_ID_PATTERN,
  WORK_ITEM_ID_PATTERN,
  checkKind,
  isActor,
  isRfc3339,
  isSha256,
} from "./patterns";
import type { Check } from "./types";

describe("isActor", () => {
  it("accepts a workspace handle", () => {
    expect(isActor("sam")).toBe(true);
    expect(isActor("priya.n_2-ops")).toBe(true);
    expect(isActor("a".repeat(ACTOR_MAX_LENGTH))).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isActor("Sam")).toBe(false);
    expect(isActor("-sam")).toBe(false);
    expect(isActor("")).toBe(false);
    expect(isActor("a".repeat(ACTOR_MAX_LENGTH + 1))).toBe(false);
    expect(isActor(42)).toBe(false);
    expect(isActor(undefined)).toBe(false);
  });
});

describe("isSha256", () => {
  it("accepts sha256: and 64 lowercase hex characters", () => {
    expect(isSha256(`sha256:${"0a".repeat(32)}`)).toBe(true);
  });

  it("refuses a short, uppercase, or unprefixed digest", () => {
    expect(isSha256(`sha256:${"a".repeat(63)}`)).toBe(false);
    expect(isSha256(`sha256:${"A".repeat(64)}`)).toBe(false);
    expect(isSha256("a".repeat(64))).toBe(false);
    expect(isSha256(null)).toBe(false);
  });
});

describe("isRfc3339", () => {
  it("accepts a UTC time, an offset time, and fractional seconds", () => {
    expect(isRfc3339("2026-09-26T18:04:11Z")).toBe(true);
    expect(isRfc3339("2026-09-26T18:04:11.123+02:00")).toBe(true);
  });

  it("refuses a date alone, a space separator, and a time that names no instant", () => {
    expect(isRfc3339("2026-09-26")).toBe(false);
    expect(isRfc3339("2026-09-26 18:04:11Z")).toBe(false);
    expect(isRfc3339("2026-13-45T00:00:00Z")).toBe(false);
    expect(isRfc3339("2026-09-26T25:00:00Z")).toBe(false);
    expect(isRfc3339(1790438651)).toBe(false);
  });
});

describe("id patterns", () => {
  it("match the ids the schema allows", () => {
    expect(CRITERION_ID_PATTERN.test("no-secrets")).toBe(true);
    expect(CRITERION_ID_PATTERN.test("a".repeat(41))).toBe(false);
    expect(CRITERION_ID_PATTERN.test("C1")).toBe(false);
    expect(WORK_ITEM_ID_PATTERN.test("wi_01K5ZQ4M8T2DXW")).toBe(true);
    expect(WORK_ITEM_ID_PATTERN.test("wi_")).toBe(false);
    expect(TRIAGE_ID_PATTERN.test("tri_01K5ZQ5A1C9E")).toBe(true);
    expect(TRIAGE_ID_PATTERN.test("tri-01")).toBe(false);
    expect(LINEAGE_PATTERN.test("aintel.core.bug-fixer")).toBe(true);
    expect(LINEAGE_PATTERN.test("aintel.")).toBe(false);
  });
});

describe("checkKind", () => {
  it("names each of the six kinds from its key", () => {
    const cases: [Check, string][] = [
      [{ run: "pnpm test" }, "run"],
      [{ file: { path: "README.md" } }, "file"],
      [{ diff: { allow: ["src/**"] } }, "diff"],
      [{ tools: { deny: ["Bash(curl *)"] } }, "tools"],
      [{ budget: { usd: 3 } }, "budget"],
      [{ human: "sam" }, "human"],
    ];
    for (const [check, kind] of cases) expect(checkKind(check)).toBe(kind);
  });
});
