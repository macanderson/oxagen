import { describe, expect, it } from "vitest";
import { RUN_TURNS_MAX, runTurnsGet } from "./run.turns.get";

const usd = (micros: string) => ({
  micros,
  currency: "USD",
  basis: "client_attested",
});

const turn = (over: Record<string, unknown> = {}) => ({
  turn: 1,
  seq: "0",
  at: "2026-09-20T09:00:00.000Z",
  frames: 62,
  modelSteps: 20,
  toolSteps: 20,
  cost: usd("30000"),
  cumulativeCost: usd("30000"),
  tokens: { inputUncached: 1834, cacheRead: 12000 },
  ...over,
});

describe("get_run_turns contract", () => {
  it("is a console read keyed on a run public id, on every surface", () => {
    expect(runTurnsGet.name).toBe("get_run_turns");
    expect(runTurnsGet.noBillingGate).toBe(true);
    expect(runTurnsGet.mutates).toBe(false);
    expect(runTurnsGet.surfaces).toEqual(["api", "mcp", "cli"]);
    expect(runTurnsGet.input.safeParse({ runId: "run_1" }).success).toBe(false);
    expect(runTurnsGet.input.safeParse({ runId: "tse_abc123" }).success).toBe(
      true,
    );
    expect(
      runTurnsGet.input.safeParse({ runId: "tse_abc123", zoom: "turns" })
        .success,
    ).toBe(false);
  });

  it("answers a turn with its steps, frames, cost and reported input", () => {
    const out = runTurnsGet.output.parse({
      runId: "tse_abc123",
      turns: [turn()],
      complete: true,
      chains: [],
    });
    expect(out.turns[0]).toEqual(turn());
  });

  it("carries a turn nothing priced, and input nothing reported, as null", () => {
    const out = runTurnsGet.output.parse({
      runId: "arun_abc123",
      turns: [
        turn({
          cost: null,
          cumulativeCost: null,
          tokens: { inputUncached: null, cacheRead: null },
        }),
      ],
      complete: true,
      chains: [],
    });
    expect(out.turns[0]?.cost).toBeNull();
    expect(out.turns[0]?.tokens).toEqual({
      inputUncached: null,
      cacheRead: null,
    });
  });

  it("refuses a turn numbered from 0, a seq that is not a frame, and a field it does not define", () => {
    const parse = (row: Record<string, unknown>) =>
      runTurnsGet.output.safeParse({
        runId: "tse_abc123",
        turns: [row],
        complete: true,
        chains: [],
      }).success;
    expect(parse(turn({ turn: 0 }))).toBe(false);
    expect(parse(turn({ seq: "tse_1" }))).toBe(false);
    expect(parse(turn({ steps: 40 }))).toBe(false);
    expect(parse(turn({ frames: -1 }))).toBe(false);
  });

  it("places each subagent chain at the turn that spawned it, and refuses a turn numbered from 0 (#4001)", () => {
    const chain = {
      sessionUuid: "3f6c0b1e-9a3d-4c2b-8e57-0d1f2a3b4c5d",
      turn: 2,
    };
    const answer = {
      runId: "tse_abc123",
      turns: [turn(), turn({ turn: 2, seq: "62" })],
      complete: true,
      chains: [chain],
    };
    expect(runTurnsGet.output.parse(answer).chains).toEqual([chain]);
    for (const chains of [
      [{ ...chain, turn: 0 }],
      [{ ...chain, sessionUuid: "sub-1" }],
      [{ ...chain, seq: "4" }],
    ]) {
      expect(runTurnsGet.output.safeParse({ ...answer, chains }).success).toBe(
        false,
      );
    }
    const { chains: _unread, ...unanswered } = answer;
    expect(runTurnsGet.output.safeParse(unanswered).success).toBe(false);
  });

  it("caps an answer at RUN_TURNS_MAX turns", () => {
    const turns = Array.from({ length: RUN_TURNS_MAX + 1 }, (_, i) =>
      turn({ turn: i + 1, seq: String(i * 62) }),
    );
    expect(
      runTurnsGet.output.safeParse({
        runId: "tse_abc123",
        turns,
        complete: false,
        chains: [],
      }).success,
    ).toBe(false);
    expect(
      runTurnsGet.output.safeParse({
        runId: "tse_abc123",
        turns: turns.slice(0, RUN_TURNS_MAX),
        complete: false,
        chains: [],
      }).success,
    ).toBe(true);
  });
});
