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
  operatorAttribution: "initiator",
  operatorRole: "member",
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
  endedAt: "2026-09-15T08:40:00.000Z",
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
  operatorAttribution: null,
  operatorRole: null,
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
  endedAt: null,
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
          operatorAttribution: "initiator",
          operatorRole: "member",
          status: "sealed",
          outcome: "completed",
          turns: 12,
          steps: 40,
          frames: 1204,
          cost: {
            micros: "4131265",
            currency: "USD",
            basis: "gateway_observed",
          },
          // The capability said nothing and the run has sealed: final.
          costIsEstimate: false,
          reportedCost: null,
          reportedTokens: null,
          effort: null,
          effortSource: null,
          fit: null,
          thinking: null,
          permissionMode: null,
          model: null,
          harness: null,
          machine: null,
          place: null,
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
          // A row the control plane sent no answer for reads as reachable.
          commandBlock: null,
          steerBlock: null,
          enrichmentEnabled: true,
          ingressRevoked: false,
          ingressPaused: false,
          completenessGaps: [],
          canSummarize: true,
          startedAt: "2026-09-15T08:00:00.000Z",
          sealedAt: "2026-09-15T08:40:00.000Z",
          sealSource: null,
          endedAt: "2026-09-15T08:40:00.000Z",
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
      operatorAttribution: null,
      // No role was stamped, and the view says so rather than guessing one.
      operatorRole: null,
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
      endedAt: null,
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

  it("carries why a command or a steer cannot reach the run (ADR-163)", () => {
    const page = toRunPage({
      runs: [
        {
          ...unpricedSession,
          commandBlock: "host_offline",
          steerBlock: "no_prompt_carrier",
        },
      ],
      nextCursor: null,
    });
    expect(RunPage.parse(page).runs[0]).toMatchObject({
      commandBlock: "host_offline",
      steerBlock: "no_prompt_carrier",
    });
  });

  it("carries an open run's cost as the estimate it is, and what sealed a run (#3980)", () => {
    const page = toRunPage({
      runs: [
        {
          ...ledgerRun,
          status: "live",
          sealedAt: null,
          costIsEstimate: true,
        },
        {
          ...ledgerRun,
          id: "tse_0000000000000000000001",
          source: "tacho",
          sealSource: "idle_timeout",
        },
      ],
      nextCursor: null,
    });
    expect(page.runs[0]).toMatchObject({ costIsEstimate: true });
    expect(page.runs[1]).toMatchObject({
      costIsEstimate: false,
      sealSource: "idle_timeout",
    });
    expect(RunPage.safeParse(page).success).toBe(true);
  });

  it("reads an open run's cost as an estimate from a server that predates the field", () => {
    const { costIsEstimate: _, ...older } = {
      ...ledgerRun,
      status: "live" as const,
      sealedAt: null,
      costIsEstimate: undefined,
    };
    expect(
      toRunPage({ runs: [older], nextCursor: null }).runs[0]?.costIsEstimate,
    ).toBe(true);
  });

  it("carries the effort get_run answers and where it was read (#3891)", () => {
    const page = toRunPage({
      runs: [
        { ...unpricedSession, effort: "high", effortSource: "request" },
        { ...unpricedSession, effort: "medium", effortSource: "harness" },
      ],
      nextCursor: null,
    });
    expect(RunPage.parse(page).runs.map((run) => run.effortSource)).toEqual([
      "request",
      "harness",
    ]);
    expect(page.runs[0]).toMatchObject({ effort: "high" });
  });

  it("carries the Model fit reading get_run stored, with its provenance (#3893)", () => {
    const fit: NonNullable<Run["fit"]> = {
      method: "run-fit/v1",
      readAt: "2026-09-15T08:45:00.000Z",
      sealedAt: "2026-09-15T08:40:00.000Z",
      read: {
        prompts: 1,
        turns: 12,
        steps: 40,
        failed: 0,
        outputTokens: 900,
        reasoningTokens: 0,
      },
      model: null,
      effort: { verdict: "unseen", why: "not_sent" },
    };
    const page = toRunPage({ runs: [{ ...ledgerRun, fit }], nextCursor: null });
    expect(RunPage.parse(page).runs[0]?.fit).toEqual(fit);
    // A list_runs row leaves it out, and the view reads no reading.
    const listed = toRunPage({ runs: [ledgerRun], nextCursor: null });
    expect(listed.runs[0]?.fit).toBeNull();
  });

  it("maps an empty page to an empty page", () => {
    expect(toRunPage({ runs: [], nextCursor: null })).toEqual({
      runs: [],
      nextCursor: null,
    });
  });

  it("carries the workspace's live count, and leaves it out when the read had none (A-04)", () => {
    const counted = toRunPage({ runs: [], nextCursor: null, liveRuns: 3 });
    expect(counted.liveRuns).toBe(3);
    expect(RunPage.safeParse(counted).success).toBe(true);
    expect(toRunPage({ runs: [], nextCursor: null })).not.toHaveProperty(
      "liveRuns",
    );
  });

  it("carries where a wrapped session ran, and null where the row says nothing (A-05)", () => {
    const place = { path: "/Users/mb/src/platform", branch: "fix/tags" };
    const page = toRunPage({
      runs: [{ ...ledgerRun, place }, ledgerRun],
      nextCursor: null,
    });
    expect(page.runs[0]?.place).toEqual(place);
    expect(page.runs[1]?.place).toBeNull();
    expect(RunPage.safeParse(page).success).toBe(true);
  });
});

describe("toRunPage: tokens, compaction and pull request state", () => {
  const tokens = {
    input_uncached: 1_200,
    cache_read: 3_600,
    cache_write_5m: 400,
    cache_write_1h: 0,
    output: 900,
    reasoning: 100,
  };

  it("carries the rollup's token classes in the view's names, and its cache rate (#3834)", () => {
    const page = toRunPage({
      runs: [{ ...ledgerRun, tokens, cacheHitRate: 0.75 }],
      nextCursor: null,
    });
    expect(RunPage.parse(page).runs[0]).toMatchObject({
      tokens: {
        inputUncached: 1_200,
        cacheRead: 3_600,
        cacheWrite5m: 400,
        cacheWrite1h: 0,
        output: 900,
        reasoning: 100,
      },
      cacheHitRate: 0.75,
    });
  });

  it("keeps no rollup row null and an unread field absent (negative)", () => {
    const [none, unread] = toRunPage({
      runs: [{ ...ledgerRun, tokens: null, cacheHitRate: null }, ledgerRun],
      nextCursor: null,
    }).runs;
    expect(none).toMatchObject({ tokens: null, cacheHitRate: null });
    expect(unread).not.toHaveProperty("tokens");
    expect(unread).not.toHaveProperty("cacheHitRate");
  });

  it("carries compacted as the ledger recorded it, and leaves it out for a wrapped session (#3835)", () => {
    const [compacted, wrapped] = toRunPage({
      runs: [{ ...ledgerRun, compacted: true }, unpricedSession],
      nextCursor: null,
    }).runs;
    expect(compacted).toMatchObject({ status: "sealed", compacted: true });
    expect(wrapped).not.toHaveProperty("compacted");
  });

  it("carries when Oxagen last read each pull request's state (#4129)", () => {
    const page = toRunPage({
      runs: [
        {
          ...unpricedSession,
          pullRequests: [
            {
              url: "https://github.com/acme/api/pull/42",
              number: 42,
              repository: "acme/api",
              state: "merged",
              stateSeenAt: "2026-09-25T10:00:00.000Z",
            },
            {
              url: "https://github.com/acme/api/pull/43",
              number: 43,
              repository: "acme/api",
              state: null,
              stateSeenAt: null,
            },
            {
              url: "https://github.com/acme/api/pull/44",
              number: 44,
              repository: "acme/api",
              state: null,
            },
          ],
        },
      ],
      nextCursor: null,
    });
    const pulls = RunPage.parse(page).runs[0]?.pullRequests;
    expect(pulls?.[0]).toMatchObject({
      state: "merged",
      stateSeenAt: "2026-09-25T10:00:00.000Z",
    });
    expect(pulls?.[1]).toMatchObject({ state: null, stateSeenAt: null });
    expect(pulls?.[2]).not.toHaveProperty("stateSeenAt");
  });
});
