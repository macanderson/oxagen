import type { runProofGet } from "@oxagen/oxagen/contracts/run.proof.get";
import type { z } from "zod";
import { moneyFromMicros } from "@/data/contracts/money";
import type { RunProof } from "@/data/contracts/run-proof";
import type { ContractOutput } from "@/server/kernel";

export function toRunProof(
  out: ContractOutput<typeof runProofGet>,
): z.input<typeof RunProof> {
  return {
    runId: out.runId,
    verdict: out.verdict,
    disclosureGrain: out.disclosureGrain,
    witnesses: out.witnesses.map(({ witnessId, attempts, ...witness }) => ({
      ...witness,
      // INV-11: the kernel's witness and signing-key identifiers are the
      // witness plane's own, not public ids Oxagen mints, so the view model
      // carries them as `…Ref`.
      witnessRef: witnessId,
      attempts: attempts.map(({ runnerAttestation, ...attempt }) => ({
        ...attempt,
        runnerAttestation: {
          keyRef: runnerAttestation.keyId,
          signature: runnerAttestation.signature,
        },
      })),
    })),
    witnessRuns: out.witnessRuns.map((run) => ({
      runId: run.runId,
      cost:
        run.cost === null
          ? null
          : {
              ...moneyFromMicros(run.cost.micros, run.cost.currency),
              basis: run.cost.basis,
            },
    })),
  };
}
