/**
 * The running assistant turns a person can stop (#4164): a stop reaches only
 * the turn registered under the same organisation, workspace, person and id,
 * a stop that arrives first is held, and a turn that ends drops out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_TURN_STOP_REASON,
  clearAssistantTurnsForTests,
  HELD_STOP_CAP,
  HELD_STOP_TTL_MS,
  registerAssistantTurn,
  stopAssistantTurn,
} from "./assistant-turn-registry";

const KEY = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  turnId: "0192d4a8-7c1e-7a00-8000-0000000000f1",
};

beforeEach(() => {
  clearAssistantTurnsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("assistant turn registry", () => {
  it("aborts a running turn with the person's reason and says it was found", () => {
    const turn = registerAssistantTurn(KEY);
    expect(turn.signal.aborted).toBe(false);

    expect(stopAssistantTurn(KEY)).toEqual({ found: true });
    expect(turn.signal.aborted).toBe(true);
    expect(turn.signal.reason).toBe(ASSISTANT_TURN_STOP_REASON);
  });

  it("answers a second stop without error, and reports it as not found", () => {
    const turn = registerAssistantTurn(KEY);
    stopAssistantTurn(KEY);
    expect(stopAssistantTurn(KEY)).toEqual({ found: false });
    expect(turn.signal.aborted).toBe(true);
  });

  it.each([
    ["another person", { userId: "user-2" }],
    ["another workspace", { workspaceId: "ws-2" }],
    ["another organisation", { orgId: "org-2" }],
    ["another turn id", { turnId: "0192d4a8-7c1e-7a00-8000-0000000000f2" }],
  ])("never reaches the turn from %s (negative)", (_label, over) => {
    const turn = registerAssistantTurn(KEY);
    expect(stopAssistantTurn({ ...KEY, ...over })).toEqual({ found: false });
    expect(turn.signal.aborted).toBe(false);
  });

  it("holds a stop that arrives before its turn, and aborts the turn as it registers", () => {
    expect(stopAssistantTurn(KEY)).toEqual({ found: false });
    const turn = registerAssistantTurn(KEY);
    expect(turn.signal.aborted).toBe(true);
    expect(turn.signal.reason).toBe(ASSISTANT_TURN_STOP_REASON);
  });

  it("applies a held stop once: a later turn under the same id runs", () => {
    stopAssistantTurn(KEY);
    registerAssistantTurn(KEY).release();
    expect(registerAssistantTurn(KEY).signal.aborted).toBe(false);
  });

  it("drops a held stop after its time is up (negative)", () => {
    vi.useFakeTimers();
    stopAssistantTurn(KEY);
    vi.advanceTimersByTime(HELD_STOP_TTL_MS + 1);
    expect(registerAssistantTurn(KEY).signal.aborted).toBe(false);
  });

  it("keeps at most the cap of held stops, dropping the oldest first", () => {
    const keyN = (n: number) => ({ ...KEY, turnId: `turn-${n}` });
    for (let n = 0; n <= HELD_STOP_CAP; n += 1) stopAssistantTurn(keyN(n));
    // The first stop was evicted to make room for the last.
    expect(registerAssistantTurn(keyN(0)).signal.aborted).toBe(false);
    expect(registerAssistantTurn(keyN(1)).signal.aborted).toBe(true);
    expect(registerAssistantTurn(keyN(HELD_STOP_CAP)).signal.aborted).toBe(
      true,
    );
  });

  it("forgets a turn once it is released: a stop after the end is held, not applied", () => {
    const turn = registerAssistantTurn(KEY);
    turn.release();
    expect(stopAssistantTurn(KEY)).toEqual({ found: false });
    expect(turn.signal.aborted).toBe(false);
  });

  it("keeps a later turn under a reused id stoppable when the earlier one releases", () => {
    const earlier = registerAssistantTurn(KEY);
    const later = registerAssistantTurn(KEY);
    earlier.release();
    expect(stopAssistantTurn(KEY)).toEqual({ found: true });
    expect(later.signal.aborted).toBe(true);
    expect(earlier.signal.aborted).toBe(false);
  });
});
