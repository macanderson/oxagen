/**
 * `get_run_proof`: the Run page's Proof tab (Mission Control spec §8.5;
 * ADR-064). Every witness that reported on the run, each with its attempts
 * as the `proof.observed` frames recorded them, the run's aggregated verdict,
 * the cost of each witness run, and the workspace's disclosure grain.
 *
 * The record names which witness failed and which were held out, which is
 * exactly what a worker must never learn (§8.5 invariants 2 and 3). The
 * handler therefore answers only a signed-in member and refuses every API-key
 * caller, and the contract has no MCP surface: MCP is where agents connect.
 * Only digests travel: no command text, test name or witness path exists in
 * the record to return.
 */
import { z } from "zod";
import {
  DISCLOSURE_GRAINS,
  ORACLE_KINDS,
  PROOF_VERDICTS,
  TAMPER_EXCLUSIONS,
  WITNESS_RESULTS,
} from "@oxagen/run-evidence";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";
import { costSchema } from "./spend.shared";

const verdictSchema = z.enum(PROOF_VERDICTS);

const proofAttemptSchema = z
  .object({
    /** 1-based, in frame order, per witness. */
    attemptNo: z.number().int().positive(),
    /** The `proof.observed` frame's position on the run, as a decimal string. */
    frameSeq: z.string().regex(/^\d+$/),
    /** RFC 3339, as the producer observed the frame. */
    observedAt: z.string().datetime(),
    targetRef: z.string(),
    targetSha: z.string(),
    prRef: z.string(),
    prSha: z.string(),
    targetResult: z.enum(WITNESS_RESULTS),
    prResult: z.enum(WITNESS_RESULTS),
    verdict: verdictSchema,
    failFingerprint: z.string().nullable(),
    passOutputDigest: z.string().nullable(),
    tamperExclusion: z.enum(TAMPER_EXCLUSIONS),
    /** The fingerprints that disagree; present exactly when `tamperExclusion` is `broken`. */
    tamper: z
      .object({ fingerprintAuthored: z.string(), fingerprintAtRun: z.string() })
      .strict()
      .nullable(),
    /** The grain the worker was briefed at for this attempt. */
    disclosureGrain: z.enum(DISCLOSURE_GRAINS),
    witnessRunId: runPublicIdSchema.nullable(),
    runnerAttestation: z
      .object({ keyId: z.string(), signature: z.string() })
      .strict(),
  })
  .strict();

const proofWitnessSchema = z
  .object({
    witnessId: z.string(),
    oracle: z.enum(ORACLE_KINDS),
    commandDigest: z.string(),
    /** Reported to the record, never to the worker. */
    heldOut: z.boolean(),
    /** The verdict of the latest attempt. */
    verdict: verdictSchema,
    attempts: z.array(proofAttemptSchema).min(1),
  })
  .strict();

export const runProofGet = registerCapability({
  name: "get_run_proof",
  domain: "run",
  description:
    "Read one run's proof record: every witness that reported on it with each attempt's target and head results, fingerprints and attestation, the run's verdict, the cost of each witness run, and the workspace's disclosure grain.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ runId: runPublicIdSchema }).strict(),
  output: z
    .object({
      runId: runPublicIdSchema,
      /** Aggregated over the witnesses' latest attempts; null when none reported. */
      verdict: verdictSchema.nullable(),
      witnesses: z.array(proofWitnessSchema),
      /** One entry per distinct witness run; `cost` null until the rollup priced it. */
      witnessRuns: z.array(
        z
          .object({ runId: runPublicIdSchema, cost: costSchema.nullable() })
          .strict(),
      ),
      /** The workspace's grain now; `L0` when nobody raised it. */
      disclosureGrain: z.enum(DISCLOSURE_GRAINS),
    })
    .strict(),
});

export type RunProofGetOutput = z.output<typeof runProofGet.output>;
