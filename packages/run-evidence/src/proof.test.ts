import { describe, expect, it } from "vitest";
import {
  aggregateRunVerdict,
  proofObservedBodySchema,
  type VerdictAttempt,
} from "./proof";

const d = (c: string) => `sha256:${c.repeat(64)}`;

/** The §8.5 example body: a flip on the head of pull request 482. */
function flipped(): Record<string, unknown> {
  return {
    witness_id: "wit_01K5RQ8M4",
    oracle: "test_flip",
    target_ref: "main",
    target_sha: "a4c91e2",
    pr_ref: "refs/pull/482/head",
    pr_sha: "f70b3d9",
    command_normalized_digest: d("1"),
    target_result: "fail",
    pr_result: "pass",
    verdict: "flipped",
    fail_fingerprint: d("2"),
    pass_output_digest: d("3"),
    tamper_exclusion: "held",
    disclosure_grain: "L0",
    witness_run_id: "tse_01k5rq5w7t2hvn9k",
    runner_attestation: { key_id: "kms:witness/v3", signature: "MEUCIQ" },
  };
}

function issues(body: Record<string, unknown>): string[] {
  const parsed = proofObservedBodySchema.safeParse(body);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."));
}

describe("proofObservedBodySchema", () => {
  it("accepts the §8.5 flip and reads held_out as false when absent", () => {
    const body = proofObservedBodySchema.parse(flipped());
    expect(body.verdict).toBe("flipped");
    expect(body.held_out).toBe(false);
  });

  it("accepts a tampered attempt whose head was excluded", () => {
    expect(
      issues({
        ...flipped(),
        verdict: "tampered",
        pr_result: "excluded",
        pass_output_digest: null,
        tamper_exclusion: "broken",
        tamper: { fingerprint_authored: d("4"), fingerprint_at_run: d("5") },
      }),
    ).toEqual([]);
  });

  it("accepts an unverified attempt that reached no result", () => {
    expect(
      issues({
        ...flipped(),
        verdict: "unverified",
        pr_result: "inconclusive",
        pass_output_digest: null,
      }),
    ).toEqual([]);
  });

  it("refuses flipped without a pass on the head (negative)", () => {
    expect(
      issues({
        ...flipped(),
        pr_result: "fail",
        pass_output_digest: null,
      }),
    ).toContain("verdict");
  });

  it("refuses flipped when the target passed (negative)", () => {
    expect(issues({ ...flipped(), target_result: "pass" })).toContain(
      "verdict",
    );
  });

  it("refuses unmoved and failing whose results say otherwise (negative)", () => {
    expect(issues({ ...flipped(), verdict: "unmoved" })).toContain("verdict");
    expect(issues({ ...flipped(), verdict: "failing" })).toContain("verdict");
  });

  it("refuses a broken fingerprint under any verdict but tampered (negative)", () => {
    expect(
      issues({
        ...flipped(),
        tamper_exclusion: "broken",
        tamper: { fingerprint_authored: d("4"), fingerprint_at_run: d("5") },
      }),
    ).toContain("tamper_exclusion");
  });

  it("refuses tampered with no fingerprints and fingerprints on a held run (negative)", () => {
    expect(
      issues({
        ...flipped(),
        verdict: "tampered",
        pr_result: "excluded",
        pass_output_digest: null,
        tamper_exclusion: "broken",
      }),
    ).toContain("tamper");
    expect(
      issues({
        ...flipped(),
        tamper: { fingerprint_authored: d("4"), fingerprint_at_run: d("5") },
      }),
    ).toContain("tamper");
  });

  it("refuses an excluded target and an excluded head outside tampered (negative)", () => {
    expect(
      issues({
        ...flipped(),
        verdict: "unsatisfied",
        target_result: "excluded",
      }),
    ).toContain("target_result");
    expect(
      issues({
        ...flipped(),
        verdict: "unsatisfied",
        pr_result: "excluded",
        pass_output_digest: null,
      }),
    ).toContain("pr_result");
  });

  it("refuses a failing side without its fingerprint (negative)", () => {
    expect(issues({ ...flipped(), fail_fingerprint: null })).toContain(
      "fail_fingerprint",
    );
  });

  it("refuses a pass output digest on a head that did not pass (negative)", () => {
    expect(
      issues({
        ...flipped(),
        verdict: "failing",
        pr_result: "fail",
      }),
    ).toContain("pass_output_digest");
  });

  it("refuses a field the schema does not name (negative)", () => {
    expect(issues({ ...flipped(), test_name: "notes.contract" })).not.toEqual(
      [],
    );
  });
});

describe("aggregateRunVerdict", () => {
  const a = (
    witnessId: string,
    attemptNo: number,
    verdict: VerdictAttempt["verdict"],
  ): VerdictAttempt => ({ witnessId, attemptNo, verdict });

  it("is null for a run with no attempt", () => {
    expect(aggregateRunVerdict([])).toBeNull();
  });

  it("takes each witness's latest attempt, whatever order the rows arrive in", () => {
    expect(
      aggregateRunVerdict([
        a("wit_1", 3, "flipped"),
        a("wit_1", 1, "failing"),
        a("wit_1", 2, "failing"),
      ]),
    ).toBe("flipped");
  });

  it("is flipped only when every witness flipped", () => {
    expect(
      aggregateRunVerdict([a("wit_1", 1, "flipped"), a("wit_2", 1, "unmoved")]),
    ).toBe("unmoved");
    expect(
      aggregateRunVerdict([a("wit_1", 1, "flipped"), a("wit_2", 1, "waived")]),
    ).toBe("flipped");
  });

  it("ranks tampered over every other word, and failing over unverified", () => {
    expect(
      aggregateRunVerdict([
        a("wit_1", 1, "flipped"),
        a("wit_2", 1, "tampered"),
        a("wit_3", 1, "failing"),
      ]),
    ).toBe("tampered");
    expect(
      aggregateRunVerdict([
        a("wit_1", 1, "unverified"),
        a("wit_2", 1, "failing"),
      ]),
    ).toBe("failing");
  });
});
