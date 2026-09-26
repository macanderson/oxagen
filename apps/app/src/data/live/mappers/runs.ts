// list_runs output to the Fleet runs page (ARCHITECTURE.md §3.4). Typed from
// the contract's `_output`, so a field the contract may omit cannot land in a
// required view field; mappers.type-test.ts holds the reverse direction.
import type { runList } from "@oxagen/oxagen/contracts/run.list";
import type { z } from "zod";
import { moneyFromMicros } from "@/data/contracts/money";
import type { RunPage } from "@/data/contracts/runs";
import type { ContractOutput } from "@/server/kernel";

type RunListOutput = ContractOutput<typeof runList>;
type RunListItem = RunListOutput["runs"][number];

/**
 * One row of `list_runs` as the tables and the Run header read it. The Run
 * page reads the same row `list_runs` returns (`get_run`'s `run`), so both
 * map through here and no field can be carried on one page and dropped on the
 * other.
 */
export function toRunRow(
  run: RunListItem,
): z.input<typeof RunPage>["runs"][number] {
  return {
    id: run.id,
    source: run.source,
    agentKey: run.agentKey,
    operatorId: run.operatorId,
    operatorKind: run.operatorKind,
    operatorName: run.operatorName,
    operatorAttribution: run.operatorAttribution,
    status: run.status,
    reportedCost: run.reportedCost ?? null,
    outcome: run.outcome,
    turns: run.turns,
    steps: run.steps,
    frames: run.frames,
    cost:
      run.cost === null
        ? null
        : {
            ...moneyFromMicros(run.cost.micros, run.cost.currency),
            basis: run.cost.basis,
          },
    // A server that predates the field says nothing, and an open run's cost
    // is then the estimate it has always been.
    costIsEstimate:
      run.costIsEstimate ?? (run.cost !== null && run.sealedAt === null),
    // The capability records the vendor slug under `id`; the view model calls
    // it `slug`, because INV-11 reserves `id` for a PublicId.
    model:
      run.model === null
        ? null
        : {
            slug: run.model.id,
            provider: run.model.provider,
            tier: run.model.tier,
          },
    effort: run.effort ?? null,
    // get_run answers where the effort was read (#3891); list_runs leaves it
    // out, and a row with no source says nothing about one.
    effortSource: run.effortSource ?? null,
    thinking: run.thinking ?? null,
    permissionMode: run.permissionMode ?? null,
    reportedTokens: run.reportedTokens ?? null,
    machine: run.machine,
    harness: run.harness ?? null,
    taskRef: run.taskRef,
    name: run.name,
    enrichmentEnabled: run.enrichmentEnabled ?? true,
    ...(run.enrichmentError ? { enrichmentError: run.enrichmentError } : {}),
    summary:
      run.summary === null
        ? null
        : {
            text: run.summary.text,
            generatedAt: run.summary.generatedAt,
            model: run.summary.model,
          },
    // Carried only when the read carried them: an absent list is "not read"
    // (a ledger run, or a failed read), which the page must not show as none.
    ...(run.pullRequests === undefined
      ? {}
      : {
          pullRequests: run.pullRequests.map((pull) => ({
            url: pull.url,
            number: pull.number,
            repository: pull.repository,
            state: pull.state,
          })),
        }),
    ...(run.pullRequestsOpened === undefined
      ? {}
      : { pullRequestsOpened: run.pullRequestsOpened }),
    ...(run.diff === undefined ? {} : { diff: run.diff }),
    replayGrade: run.replayGrade,
    verdict: run.verdict,
    enforcementTier: run.enforcementTier,
    commandBlock: run.commandBlock ?? null,
    steerBlock: run.steerBlock ?? null,
    ingressRevoked: run.ingressRevoked ?? false,
    ingressPaused: run.ingressPaused ?? false,
    completenessGaps: run.completenessGaps,
    canSummarize: run.canSummarize,
    startedAt: run.startedAt,
    sealedAt: run.sealedAt,
    sealSource: run.sealSource ?? null,
    endedAt: run.endedAt,
  };
}

export function toRunPage(out: RunListOutput): z.input<typeof RunPage> {
  return {
    runs: out.runs.map(toRunRow),
    nextCursor: out.nextCursor,
    ...(out.warnings === undefined ? {} : { warnings: out.warnings }),
  };
}
