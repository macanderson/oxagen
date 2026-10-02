import { describe, expect, it } from "vitest";
import { ITEM, OPEN_WORK, PRIORITIES, recordedDecision } from "./fixtures/triage-fixtures";
import { priorityCites } from "./priorities-rules";
import { type TriageOutputContext, checkTriageOutput } from "./triage-output";

const context: TriageOutputContext = { item: ITEM.id, cites: priorityCites(PRIORITIES), openWork: OPEN_WORK };

describe("checkTriageOutput", () => {
  it("passes the recorded decision", () => {
    expect(checkTriageOutput(recordedDecision(), context)).toEqual([]);
  });

  it("rejects a decision about another item", () => {
    const decision = { ...recordedDecision(), item: "wi_01K5ZZZZZZZZZZ" as const };
    expect(checkTriageOutput(decision, context)).toEqual([
      "/item is wi_01K5ZZZZZZZZZZ, but triage was asked about wi_01K5ZQ4M8T2DXW",
    ]);
  });

  it("rejects a cite the priorities record does not number", () => {
    const decision = recordedDecision();
    decision.priority.cites = ["aintel.work.priorities#2", "aintel.work.priorities#7", "other.priorities#1"];
    expect(checkTriageOutput(decision, context)).toEqual([
      "/priority/cites names aintel.work.priorities#7, which is not a rule of the priorities record",
      "/priority/cites names other.priorities#1, which is not a rule of the priorities record",
    ]);
  });

  it("rejects a duplicate or related item that is the item itself or not open work", () => {
    const decision = recordedDecision();
    decision.duplicates = [ITEM.id];
    decision.related = ["wi_01K5YV0B3N7PRA", "wi_01K5UNKNOWN000"];
    expect(checkTriageOutput(decision, context)).toEqual([
      "/duplicates names the item itself",
      "/related names wi_01K5UNKNOWN000, which is not in the open work",
    ]);
  });
});
