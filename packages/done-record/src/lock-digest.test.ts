// lock-digest.test.ts: the lock digest of the spec's example, and lockRecord.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { DoneRecordError } from "./errors";
import type { EvaluatorPin, EvaluatorRegistry } from "./lint";
import { OXAGEN_LOCK_ACTOR, lockDigest, lockMatches, lockRecord } from "./lock-digest";
import { CHECK_KINDS, ORACLE_CLASSES, type DoneRecord } from "./types";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/**
 * SHA-256 over the spec's example in RFC 8785 form, with `lock` left out.
 * Computed once from fixtures/done-record.yaml and pinned here. The spec's own
 * `lock.digest` is illustrative, so it does not match, and the last test in
 * this file says so.
 */
const SPEC_EXAMPLE_DIGEST = "sha256:497a7d7b9256f54a416fc40da037f4abd71f03fd4257db200f57f5912ef60917";

const PIN = `sha256:${"a".repeat(64)}` as EvaluatorPin;
const registry: EvaluatorRegistry = {
  oracles: Object.fromEntries(ORACLE_CLASSES.map((cls) => [cls, PIN])) as EvaluatorRegistry["oracles"],
  checks: Object.fromEntries(CHECK_KINDS.map((kind) => [kind, PIN])) as EvaluatorRegistry["checks"],
};

function specExample(): DoneRecord {
  return parseYaml(readFileSync(join(FIXTURES, "done-record.yaml"), "utf8")) as DoneRecord;
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof DoneRecordError) return error.code;
    throw error;
  }
  return undefined;
}

describe("lockDigest", () => {
  it("matches the fixed digest for the spec's example", () => {
    expect(lockDigest(specExample())).toBe(SPEC_EXAMPLE_DIGEST);
  });

  it("leaves the lock out", () => {
    const { lock: _lock, ...unlocked } = specExample();
    expect(lockDigest(unlocked)).toBe(SPEC_EXAMPLE_DIGEST);
  });

  it("does not depend on key order or on keys whose value is undefined", () => {
    const record = specExample();
    const reordered: DoneRecord = {
      criteria: record.criteria.map((criterion) => ({ ...criterion, oracle: criterion.oracle, negative: criterion.negative })),
      lineage: record.lineage,
      item: record.item,
      schema: record.schema,
      drafted_by: record.drafted_by,
    };
    expect(lockDigest(reordered)).toBe(SPEC_EXAMPLE_DIGEST);
  });

  it("changes when a criterion changes", () => {
    const record = specExample();
    const edited: DoneRecord = {
      ...record,
      criteria: record.criteria.map((criterion) =>
        criterion.id === "c1" ? { ...criterion, text: "Invoice export finishes." } : criterion,
      ),
    };
    expect(lockDigest(edited)).not.toBe(SPEC_EXAMPLE_DIGEST);
  });
});

describe("lockRecord", () => {
  const at = "2026-09-26T18:04:11Z";

  it("writes the lock a person asks for and replaces the old one", () => {
    const locked = lockRecord(specExample(), { by: "priya", at }, registry);
    expect(locked.lock).toEqual({ digest: SPEC_EXAMPLE_DIGEST, by: "priya", at });
    expect(lockMatches(locked)).toBe(true);
  });

  it("lets Oxagen lock only at autonomy level 3", () => {
    const locked = lockRecord(specExample(), { by: OXAGEN_LOCK_ACTOR, at, level: 3 }, registry);
    expect(locked.lock?.by).toBe("oxagen");
    expect(errorCode(() => lockRecord(specExample(), { by: OXAGEN_LOCK_ACTOR, at, level: 2 }, registry))).toBe(
      "invalid_input",
    );
    expect(errorCode(() => lockRecord(specExample(), { by: OXAGEN_LOCK_ACTOR, at }, registry))).toBe("invalid_input");
  });

  it("refuses a handle that is not a workspace handle", () => {
    expect(errorCode(() => lockRecord(specExample(), { by: "Priya Nair", at }, registry))).toBe("invalid_input");
  });

  it("refuses a time that is not RFC 3339", () => {
    expect(errorCode(() => lockRecord(specExample(), { by: "priya", at: "yesterday" }, registry))).toBe(
      "invalid_input",
    );
  });

  it("refuses a record that fails lint and names the rules", () => {
    const record: DoneRecord = {
      schema: "done-record/v1",
      item: "wi_01K5ZQ4M8T2DXW",
      lineage: "aintel.platform.export",
      criteria: [{ id: "c1", text: "The change touches only billing code.", tag: "code", check: { diff: { allow: ["src/billing/**"] } } }],
    };
    expect.assertions(3);
    try {
      lockRecord(record, { by: "priya", at }, registry);
    } catch (error) {
      expect(error).toBeInstanceOf(DoneRecordError);
      expect((error as DoneRecordError).code).toBe("lint_failed");
      expect((error as DoneRecordError).message).toContain("NOTHING_TO_EXECUTE, NEGATIVE_MISSING (c1)");
    }
  });
});

describe("lockMatches", () => {
  it("is false for an unlocked record and for one edited after its lock", () => {
    const { lock: _lock, ...unlocked } = specExample();
    expect(lockMatches(unlocked)).toBe(false);
    const locked = lockRecord(unlocked, { by: "priya", at: "2026-09-26T18:04:11Z" }, registry);
    const edited: DoneRecord = { ...locked, lineage: "aintel.platform.other" };
    expect(lockMatches(edited)).toBe(false);
  });

  it("is false for the spec's example, whose lock digest is illustrative", () => {
    expect(lockMatches(specExample())).toBe(false);
  });
});
