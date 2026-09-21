import { z } from "zod";
import { PublicId } from "./common";
import { Cost } from "./money";

const Verdict = z.enum([
  "flipped",
  "failing",
  "unmoved",
  "unsatisfied",
  "tampered",
  "unverified",
  "waived",
]);
const Result = z.enum(["pass", "fail", "excluded", "inconclusive"]);
const Grain = z.enum(["L0", "L1", "L2", "L3"]);
const Attempt = z.object({
  attemptNo: z.number().int().positive(),
  frameSeq: z.string(),
  observedAt: z.iso.datetime({ offset: true }),
  targetRef: z.string(),
  targetSha: z.string(),
  prRef: z.string(),
  prSha: z.string(),
  targetResult: Result,
  prResult: Result,
  verdict: Verdict,
  failFingerprint: z.string().nullable(),
  passOutputDigest: z.string().nullable(),
  tamperExclusion: z.enum(["held", "broken"]),
  tamper: z
    .object({ fingerprintAuthored: z.string(), fingerprintAtRun: z.string() })
    .nullable(),
  disclosureGrain: Grain,
  witnessRunId: PublicId.nullable(),
  runnerAttestation: z.object({ keyRef: z.string(), signature: z.string() }),
});

export const RunProof = z.object({
  runId: PublicId,
  verdict: Verdict.nullable(),
  disclosureGrain: Grain,
  witnesses: z.array(
    z.object({
      witnessRef: z.string(),
      oracle: z.enum([
        "test_flip",
        "build_or_type",
        "property",
        "golden_snapshot",
        "contract",
        "metamorphic",
        "behavioral_probe",
      ]),
      commandDigest: z.string(),
      heldOut: z.boolean(),
      verdict: Verdict,
      attempts: z.array(Attempt).min(1),
    }),
  ),
  witnessRuns: z.array(z.object({ runId: PublicId, cost: Cost.nullable() })),
});
export type RunProof = z.infer<typeof RunProof>;
