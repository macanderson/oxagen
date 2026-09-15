// list_runs output to the Fleet runs page (ARCHITECTURE.md §3.4). Typed from
// the contract's `_output`, so a field the contract may omit cannot land in a
// required view field; mappers.type-test.ts holds the reverse direction.
import type { runList } from "@oxagen/oxagen/contracts/run.list";
import type { z } from "zod";
import { moneyFromMicros } from "@/data/contracts/money";
import type { RunPage } from "@/data/contracts/runs";
import type { ContractOutput } from "@/server/kernel";

type RunListOutput = ContractOutput<typeof runList>;

export function toRunPage(out: RunListOutput): z.input<typeof RunPage> {
  return {
    runs: out.runs.map((run) => ({
      id: run.id,
      source: run.source,
      agentKey: run.agentKey,
      operatorId: run.operatorId,
      status: run.status,
      frames: run.frames,
      cost:
        run.cost === null
          ? null
          : {
              ...moneyFromMicros(run.cost.micros, run.cost.currency),
              basis: run.cost.basis,
            },
      taskRef: run.taskRef,
      startedAt: run.startedAt,
    })),
    nextCursor: out.nextCursor,
  };
}
