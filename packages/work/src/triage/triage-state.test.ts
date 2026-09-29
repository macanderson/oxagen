import { describe, expect, it } from "vitest";
import type { TriageDecision } from "../types";
import { triageItemState } from "./triage-state";

describe("triageItemState", () => {
  it.each<[TriageDecision["state"], TriageDecision["duplicates"], ReturnType<typeof triageItemState>]>([
    ["triaged", [], { state: "triaged", heldReason: null, duplicateOf: null }],
    ["needs_info", [], { state: "needs_info", heldReason: null, duplicateOf: null }],
    ["out_of_scope", [], { state: "held", heldReason: "out_of_scope", duplicateOf: null }],
    [
      "duplicate",
      ["wi_01K5YV0B3N7PRA", "wi_01K5YV0B3N7PRB"],
      { state: "held", heldReason: "duplicate", duplicateOf: "wi_01K5YV0B3N7PRA" },
    ],
    ["duplicate", [], { state: "held", heldReason: "duplicate", duplicateOf: null }],
  ])("sets %s with duplicates %j", (state, duplicates, expected) => {
    expect(triageItemState({ state, duplicates })).toEqual(expected);
  });
});
