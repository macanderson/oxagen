// proof.ts — the `proof.observed` frame body and the verdict vocabulary
// (Mission Control spec §8.2, §8.5; ADR-064).
//
// A witness fails on the PR's target and passes on the PR head; the runner
// records that as a `proof.observed` frame on the worker's run. This module is
// the body's one schema: the ingest contract validates every such frame
// against it, the database CHECKs take their word lists from it, and the
// rollup and the proof read aggregate a run's verdict with the one function
// below. No model resolves a verdict: every word here comes from the runner.

import { z } from "zod";

/** The frame kind a witness verdict lands on the worker's run as. */
export const PROOF_OBSERVED_KIND = "proof.observed";

/**
 * The closed verdict vocabulary (§8.5). Only `flipped` marks a run proven;
 * `unverified` is the recorded answer when the runner could not conclude.
 */
export const PROOF_VERDICTS = [
  "flipped",
  "failing",
  "unmoved",
  "unsatisfied",
  "tampered",
  "unverified",
  "waived",
] as const;
export type ProofVerdict = (typeof PROOF_VERDICTS)[number];

/** The oracle ladder (§8.5), deterministic first. */
export const ORACLE_KINDS = [
  "test_flip",
  "build_or_type",
  "property",
  "golden_snapshot",
  "contract",
  "metamorphic",
  "behavioral_probe",
] as const;

/**
 * What one run of the witness command produced on one side. `excluded` is a
 * head result the tamper exclusion threw out; `inconclusive` is a run that
 * reached no result (a timeout, a crash, a missing fixture).
 */
export const WITNESS_RESULTS = [
  "pass",
  "fail",
  "excluded",
  "inconclusive",
] as const;

/**
 * How much the worker is told (§8.5 invariant 3). `L0` is pass or fail and
 * nothing else; a human raises it, recorded as a security event.
 */
export const DISCLOSURE_GRAINS = ["L0", "L1", "L2", "L3"] as const;
export type DisclosureGrain = (typeof DISCLOSURE_GRAINS)[number];

/** Whether the witness's filesystem fingerprint held between authoring and the run. */
export const TAMPER_EXCLUSIONS = ["held", "broken"] as const;

/** Public run ids of the two recorders: the evidence ledger and a wrapped session. */
const RUN_PUBLIC_ID_PATTERN = /^(arun|tse)_[0-9a-z]{1,64}$/;

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const gitSha = z.string().regex(/^[0-9a-f]{7,64}$/);
const ref = z.string().min(1).max(256);

export const proofObservedBodySchema = z
  .object({
    witness_id: z.string().regex(/^wit_[0-9A-Za-z]{1,64}$/),
    oracle: z.enum(ORACLE_KINDS),
    target_ref: ref,
    target_sha: gitSha,
    pr_ref: ref,
    pr_sha: gitSha,
    /** The same normalized command runs on both sides; only its digest travels. */
    command_normalized_digest: digest,
    target_result: z.enum(WITNESS_RESULTS),
    pr_result: z.enum(WITNESS_RESULTS),
    verdict: z.enum(PROOF_VERDICTS),
    /** A hash of the failure output; present whenever a side failed. */
    fail_fingerprint: digest.nullable().default(null),
    /** A hash of the passing output; present whenever the head passed. */
    pass_output_digest: digest.nullable().default(null),
    tamper_exclusion: z.enum(TAMPER_EXCLUSIONS),
    /** The two fingerprints that disagree; present exactly when the exclusion broke. */
    tamper: z
      .object({ fingerprint_authored: digest, fingerprint_at_run: digest })
      .strict()
      .optional(),
    disclosure_grain: z.enum(DISCLOSURE_GRAINS),
    /** A held-out witness is reported to the record and never to the worker. */
    held_out: z.boolean().default(false),
    /** The witness's own run; null when the producer ran it without recording one. */
    witness_run_id: z.string().regex(RUN_PUBLIC_ID_PATTERN).nullable(),
    runner_attestation: z
      .object({
        key_id: z.string().min(1).max(256),
        signature: z.string().min(1).max(1024),
      })
      .strict(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const refuse = (message: string, path: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    const { verdict, target_result: target, pr_result: pr } = body;
    if (
      verdict === "flipped" &&
      !(target === "fail" && pr === "pass" && body.tamper_exclusion === "held")
    )
      refuse(
        "flipped needs a fail on the target, a pass on the head and a held fingerprint",
        "verdict",
      );
    if (verdict === "unmoved" && !(target === "pass" && pr === "pass"))
      refuse("unmoved needs a pass on both sides", "verdict");
    if (verdict === "failing" && !(target === "fail" && pr === "fail"))
      refuse("failing needs a fail on both sides", "verdict");
    if ((body.tamper_exclusion === "broken") !== (verdict === "tampered"))
      refuse(
        "a broken tamper exclusion is exactly the tampered verdict",
        "tamper_exclusion",
      );
    if ((body.tamper !== undefined) !== (body.tamper_exclusion === "broken"))
      refuse(
        "tamper names the fingerprints exactly when the exclusion broke",
        "tamper",
      );
    if (target === "excluded")
      refuse("only the head result can be excluded", "target_result");
    if ((pr === "excluded") !== (verdict === "tampered"))
      refuse(
        "an excluded head result is exactly the tampered verdict",
        "pr_result",
      );
    if ((target === "fail" || pr === "fail") && body.fail_fingerprint === null)
      refuse("a failing side carries its fingerprint", "fail_fingerprint");
    if ((pr === "pass") !== (body.pass_output_digest !== null))
      refuse(
        "the pass output digest is present exactly when the head passed",
        "pass_output_digest",
      );
  });

/**
 * The order a run's verdict is read in when its witnesses disagree: the first
 * word any witness holds wins. A broken fingerprint outranks everything, since
 * the ground under the oracle moved; a definite fail outranks an attempt that
 * could not conclude; a run is `flipped` only when every witness flipped
 * (a `waived` witness claims nothing and does not block it).
 */
const PRECEDENCE: readonly ProofVerdict[] = [
  "tampered",
  "failing",
  "unsatisfied",
  "unverified",
  "unmoved",
  "flipped",
  "waived",
];

export interface VerdictAttempt {
  witnessId: string;
  attemptNo: number;
  verdict: ProofVerdict;
}

/**
 * A run's verdict from its recorded attempts: each witness holds the verdict
 * of its latest attempt, and the run takes the highest-ranked word among its
 * witnesses. Null when the run has no attempt. Held-out witnesses count: they
 * are hidden from the worker, never from the record.
 */
export function aggregateRunVerdict(
  attempts: readonly VerdictAttempt[],
): ProofVerdict | null {
  const latest = new Map<string, VerdictAttempt>();
  for (const attempt of attempts) {
    const held = latest.get(attempt.witnessId);
    if (!held || attempt.attemptNo > held.attemptNo)
      latest.set(attempt.witnessId, attempt);
  }
  if (latest.size === 0) return null;
  const words = new Set([...latest.values()].map((a) => a.verdict));
  return PRECEDENCE.find((word) => words.has(word)) ?? null;
}
