// The Work walk's contract (ADR-255), proven without a browser or a database:
// every seeded state has its own key and title, every Work tab holds one, and
// each state sits on the tab the server gives its reduced state. walk.ts reads
// these in a browser, so a mismatch here would fail there after a full build.
import { tabOf } from "@oxagen/handlers/lib/work-read/derive";
import { describe, expect, it } from "vitest";
import { WALK_STATES, walkState, workWalkRecordSchema } from "./states";

describe("the Work walk's seeded states", () => {
  it("gives every state its own key and title", () => {
    expect(new Set(WALK_STATES.map((state) => state.key)).size).toBe(WALK_STATES.length);
    expect(new Set(WALK_STATES.map((state) => state.title)).size).toBe(WALK_STATES.length);
  });

  it("seeds every tab of the Work page", () => {
    expect(new Set(WALK_STATES.map((state) => state.tab))).toEqual(
      new Set(["inbox", "running", "review", "done"]),
    );
  });

  it("lists each state on the tab the server gives its reduced state", () => {
    for (const state of WALK_STATES) {
      expect({ key: state.key, tab: tabOf(state.reduced) }).toEqual({ key: state.key, tab: state.tab });
    }
  });

  it("finds a state by its key", () => {
    expect(walkState("stale_evidence").wait).toBe("new_head");
    expect(() => walkState("missing" as never)).toThrow("No seeded state is named missing.");
  });
});

describe("the seed:work record", () => {
  const items = Object.fromEntries(
    WALK_STATES.map((state, index) => [state.key, { number: `WI-${String(index + 2)}`, id: `wi_${String(index)}abc` }]),
  );
  const record = {
    schema: 1,
    orgSlug: "e2e-org",
    workspaceSlug: "core",
    items,
    agents: { send: "agt_send1", queued: "agt_queued1", busy: "agt_busy1" },
    collector: "e2e-github",
    criteria: ["c1", "c2"],
  };

  it("accepts a record that names every seeded state", () => {
    expect(workWalkRecordSchema.safeParse(record).success).toBe(true);
  });

  it("refuses a record that misses a seeded state", () => {
    const { done: _done, ...rest } = items;
    expect(workWalkRecordSchema.safeParse({ ...record, items: rest }).success).toBe(false);
  });

  it("refuses an item number that is not WI-n", () => {
    expect(
      workWalkRecordSchema.safeParse({ ...record, items: { ...items, done: { number: "12", id: "wi_x" } } }).success,
    ).toBe(false);
  });
});
