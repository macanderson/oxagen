// toRunPage over sample list_runs outputs: every recorded field carried as the
// contract wrote it, and a null operator, agent, cost or basis kept null.
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
  operatorId: "usr_marcusbell",
  status: "sealed",
  turns: 12,
  steps: 40,
  frames: 1204,
  cost: { micros: "0004131265", currency: "USD", basis: "gateway_observed" },
  taskRef: "ENG-4121",
  startedAt: "2026-09-15T08:00:00.000Z",
  sealedAt: "2026-09-15T08:40:00.000Z",
};

const unpricedSession: Run = {
  id: "tse_4f0a",
  source: "tacho",
  agentKey: null,
  operatorId: null,
  status: "live",
  turns: null,
  steps: 3,
  frames: 9,
  cost: null,
  taskRef: null,
  startedAt: "2026-09-15T08:55:00.000Z",
  sealedAt: null,
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
          operatorId: "usr_marcusbell",
          status: "sealed",
          frames: 1204,
          cost: {
            micros: "4131265",
            currency: "USD",
            basis: "gateway_observed",
          },
          taskRef: "ENG-4121",
          startedAt: "2026-09-15T08:00:00.000Z",
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
      cost: null,
      taskRef: null,
    });
    expect(page.nextCursor).toBeNull();
    expect(RunPage.safeParse(page).success).toBe(true);
  });

  it("maps an empty page to an empty page", () => {
    expect(toRunPage({ runs: [], nextCursor: null })).toEqual({
      runs: [],
      nextCursor: null,
    });
  });
});
