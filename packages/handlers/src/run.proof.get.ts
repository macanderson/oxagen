// audit-exempt: read-only — answers one run's witness record from evidence.verdicts and evidence.witnesses; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_run_proof` (ADR-064): the Run page's Proof tab. Every witness that
// reported on the run with each attempt as its `proof.observed` frame recorded
// it, the run's verdict aggregated the one way the rollup aggregates it, the
// cost of each witness run from `cost.run_totals`, and the workspace's grain.
//
// A signed-in member only: `requireSessionUser` refuses every API-key caller
// (a worker holds API keys and must not learn which witness failed), and
// `assertOrgRole` refuses anyone outside the org's members.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  runProofGet,
  type RunProofGetOutput,
} from "@oxagen/oxagen/contracts/run.proof.get";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  aggregateRunVerdict,
  ORACLE_KINDS,
  PROOF_VERDICTS,
  TAMPER_EXCLUSIONS,
  WITNESS_RESULTS,
  DISCLOSURE_GRAINS,
} from "@oxagen/run-evidence";
import { z } from "zod";
import {
  closedWord,
  type ProofRecord,
  type ProofScope,
  readRunProof,
  requireSessionUser,
} from "./lib/proof";
import { cost, readRunTotalsByIds } from "./spend.shared";

type Witness = RunProofGetOutput["witnesses"][number];
type Attempt = Witness["attempts"][number];

const tamperSchema = z
  .object({ fingerprint_authored: z.string(), fingerprint_at_run: z.string() })
  .strict();
const attestationSchema = z
  .object({ key_id: z.string(), signature: z.string() })
  .strict();

export type RunProofDeps = {
  readRunProof: (scope: ProofScope, runId: string) => Promise<ProofRecord>;
  readRunTotalsByIds: typeof readRunTotalsByIds;
};

function toAttempt(row: ProofRecord["attempts"][number]): Attempt {
  const tamper = row.tamper === null ? null : tamperSchema.parse(row.tamper);
  const attestation = attestationSchema.parse(row.runnerAttestation);
  return {
    attemptNo: row.attemptNo,
    frameSeq: String(row.frameSeq),
    observedAt: row.observedAt.toISOString(),
    targetRef: row.targetRef,
    targetSha: row.targetSha,
    prRef: row.prRef,
    prSha: row.prSha,
    targetResult: closedWord(WITNESS_RESULTS, row.targetResult),
    prResult: closedWord(WITNESS_RESULTS, row.prResult),
    verdict: closedWord(PROOF_VERDICTS, row.verdict),
    failFingerprint: row.failFingerprint,
    passOutputDigest: row.passOutputDigest,
    tamperExclusion: closedWord(TAMPER_EXCLUSIONS, row.tamperExclusion),
    tamper:
      tamper === null
        ? null
        : {
            fingerprintAuthored: tamper.fingerprint_authored,
            fingerprintAtRun: tamper.fingerprint_at_run,
          },
    disclosureGrain: closedWord(DISCLOSURE_GRAINS, row.disclosureGrain),
    witnessRunId: row.witnessRunId,
    runnerAttestation: {
      keyId: attestation.key_id,
      signature: attestation.signature,
    },
  };
}

export function createRunProofHandler(
  deps: RunProofDeps,
): CapabilityHandler<typeof runProofGet> {
  return async (input, ctx): Promise<RunProofGetOutput> => {
    requireSessionUser(ctx);
    await assertOrgRole(
      { ...ctx, userId: await resolveActingUserId(ctx) },
      { org: ["Owner", "Admin", "Member"], workspace: ["Owner", "Member"] },
    );
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const record = await deps.readRunProof(scope, input.runId);

    const identities = new Map(record.witnesses.map((w) => [w.witnessId, w]));
    const byWitness = new Map<string, Witness>();
    for (const row of record.attempts) {
      const attempt = toAttempt(row);
      const held = byWitness.get(row.witnessId);
      // Rows arrive in frame order and attempts are numbered in frame order,
      // so the last row read is the witness's latest attempt.
      if (held) {
        held.attempts.push(attempt);
        held.verdict = attempt.verdict;
        continue;
      }
      const identity = identities.get(row.witnessId);
      if (!identity)
        throw new RangeError(`verdict names no witness row: ${row.witnessId}`);
      byWitness.set(row.witnessId, {
        witnessId: identity.witnessId,
        oracle: closedWord(ORACLE_KINDS, identity.oracleKind),
        commandDigest: identity.commandDigest,
        heldOut: identity.heldOut,
        verdict: attempt.verdict,
        attempts: [attempt],
      });
    }

    const witnessRunIds = [
      ...new Set(
        record.attempts.flatMap((row) =>
          row.witnessRunId === null ? [] : [row.witnessRunId],
        ),
      ),
    ];
    const totals = await deps.readRunTotalsByIds(scope, witnessRunIds);
    const witnesses = [...byWitness.values()];
    return {
      runId: input.runId,
      verdict: aggregateRunVerdict(
        witnesses.flatMap((w) =>
          w.attempts.map((a) => ({
            witnessId: w.witnessId,
            attemptNo: a.attemptNo,
            verdict: a.verdict,
          })),
        ),
      ),
      witnesses,
      witnessRuns: witnessRunIds.map((runId) => {
        const row = totals.get(runId);
        return {
          runId,
          cost: row ? cost(row.costMicros, row.currency, row.costBasis) : null,
        };
      }),
      disclosureGrain: record.grain,
    };
  };
}

export const runProofHandler = createRunProofHandler({
  readRunProof,
  readRunTotalsByIds,
});
