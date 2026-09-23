// toRunPage over sample list_runs outputs: every recorded field carried as the
// contract wrote it, and a null operator, agent, cost, basis, name, summary or
// replay grade kept null. A field the contract carries and the view drops is
// how the Fleet table ends up listing runs nobody can tell apart, so the
// recorded case asserts the whole row rather than a subset of it.
import type { runList } from "@oxagen/oxagen/contracts/run.list";
import { describe, expect, it } from "vitest";
import { RunPage } from "@/data/contracts/runs";
import type { ContractOutput } from "@/server/kernel";
import { toRunPage } from "./runs";

type Run = ContractOutput<typeof runList>["runs"][number];

const ledgerRun: Run = {
  id: "arun_7k2m9q",
  source: "ledger",
  agentKey: "acme.core.release-bot",
  operatorId: "prn_marcusbell",
  operatorKind: "human",
  operatorName: "Marcus Bell",
  status: "sealed",
  outcome: "completed",
  turns: 12,
  steps: 40,
  frames: 1204,
  cost: { micros: "0004131265", currency: "USD", basis: "gateway_observed" },
  model: null,
  machine: null,
  taskRef: "ENG-4121",
  startedAt: "2026-09-15T08:00:00.000Z",
  sealedAt: "2026-09-15T08:40:00.000Z",
  replayGrade: "fork",
  verdict: null,
  enforcementTier: "gateway",
  completenessGaps: [],
  canSummarize: true,
  name: "Cut the 3.2 release branch",
  summary: {
    text: "Cut release/3.2 from main and opened the release pull request.",
    generatedAt: "2026-09-15T08:58:00.000Z",
    model: "z-ai/glm-flash-latest",
  },
};

const unpricedSession: Run = {
  id: "tse_4f0a",
  source: "tacho",
  agentKey: null,
  operatorId: null,
  operatorKind: null,
  operatorName: null,
  status: "live",
  outcome: "running",
  turns: null,
  steps: 3,
  frames: 9,
  cost: null,
  model: {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    tier: "haiku",
  },
  machine: {
    hostname: "mac-studio.local",
    platform: "darwin",
    osVersion: "15.6",
    arch: "arm64",
    nodeVersion: "v24.4.0",
  },
  taskRef: null,
  startedAt: "2026-09-15T08:55:00.000Z",
  sealedAt: null,
  replayGrade: null,
  verdict: null,
  // A live observe-tier session: it records what the agent did and gives
  // Oxagen no connection point, so the page disables the direct controls.
  enforcementTier: "observe",
  completenessGaps: [],
  canSummarize: false,
  name: null,
  summary: null,
};

describe("toRunPage", () => {
  it("carries a recorded run, with its cost in canonical micros and its basis", () => {
    const page = toRunPage({ runs: [ledgerRun], nextCursor: "c2" });
    expect(page).toEqual({
      runs: [
        {
          id: "arun_7k2m9q",
          source: "ledger",
          agentKey: "acme.core.release-bot",
          operatorId: "prn_marcusbell",
          operatorKind: "human",
          operatorName: "Marcus Bell",
          status: "sealed",
          reportedCost: null,
          outcome: "completed",
          turns: 12,
          steps: 40,
          frames: 1204,
          cost: {
            micros: "4131265",
            currency: "USD",
            basis: "gateway_observed",
          },
          reportedCost: null,
          model: null,
          harness: null,
          machine: null,
          taskRef: "ENG-4121",
          name: "Cut the 3.2 release branch",
          summary: {
            text: "Cut release/3.2 from main and opened the release pull request.",
            generatedAt: "2026-09-15T08:58:00.000Z",
            model: "z-ai/glm-flash-latest",
          },
          replayGrade: "fork",
          verdict: null,
          enforcementTier: "gateway",
          ingressRevoked: false,
          ingressPaused: false,
          completenessGaps: [],
          canSummarize: true,
          startedAt: "2026-09-15T08:00:00.000Z",
          sealedAt: "2026-09-15T08:40:00.000Z",
        },
      ],
      nextCursor: "c2",
    });
    expect(RunPage.safeParse(page).success).toBe(true);
  });

  it("keeps a null operator, agent, task and cost null, never a zero or a stand-in", () => {
    const page = toRunPage({ runs: [unpricedSession], nextCursor: null });
    expect(page.runs[0]).toMatchObject({
      agentKey: null,
      operatorId: null,
      operatorKind: null,
      operatorName: null,
      // The session recorded both, so neither is dropped on the way to the view.
      model: {
        slug: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        tier: "haiku",
      },
      machine: { hostname: "mac-studio.local", platform: "darwin" },
      cost: null,
      taskRef: null,
      turns: null,
      name: null,
      summary: null,
      replayGrade: null,
      sealedAt: null,
      // An observe-tier live session: the row says where it was observed from,
      // what the seal has not recorded, and that summarizing would be refused,
      // so a page can disable the controls rather than offer four that fail.
      enforcementTier: "observe",
      completenessGaps: [],
      canSummarize: false,
    });
    expect(page.nextCursor).toBeNull();
    expect(RunPage.safeParse(page).success).toBe(true);
  });

  it("keeps ledger ingress revocation separate from recorded process status", () => {
    const page = toRunPage({
      runs: [
        {
          ...ledgerRun,
          status: "live",
          ingressRevoked: true,
          ingressPaused: true,
        },
      ],
      nextCursor: null,
    });
    expect(RunPage.parse(page).runs[0]).toMatchObject({
      status: "live",
      ingressRevoked: true,
      ingressPaused: true,
    });
  });

  it("maps an empty page to an empty page", () => {
    expect(toRunPage({ runs: [], nextCursor: null })).toEqual({
      runs: [],
      nextCursor: null,
    });
  });
});
