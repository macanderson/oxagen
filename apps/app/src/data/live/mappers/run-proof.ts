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
    witnesses: out.witnesses.map((witness) => ({
      ...witness,
      attempts: witness.attempts.map((attempt) => ({ ...attempt })),
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
