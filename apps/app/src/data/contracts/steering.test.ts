// The Steering view model mirrors the shared contract's proposal kinds
// (#5122), so a kind the platform adds fails here before a mapper or a label
// map meets it.
import {
  isSteeringPrKind as isSharedSteeringPrKind,
  proposalKindSchema,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { describe, expect, it } from "vitest";
import { isSteeringPrKind, ProposalKind } from "./steering";

describe("ProposalKind", () => {
  it("mirrors the contract's proposal kinds in the contract's order", () => {
    expect([...ProposalKind.options]).toEqual([...proposalKindSchema.options]);
  });

  it("names a steering PR kind exactly as the contract does", () => {
    for (const kind of ProposalKind.options) {
      expect([kind, isSteeringPrKind(kind)]).toEqual([
        kind,
        isSharedSteeringPrKind(kind),
      ]);
    }
  });

  it("reads no record kind and no governance change as a steering PR (negative)", () => {
    expect(isSteeringPrKind("rule")).toBe(false);
    expect(isSteeringPrKind("memory")).toBe(false);
    expect(isSteeringPrKind("governance")).toBe(false);
    expect(isSteeringPrKind("memory_pr")).toBe(true);
  });
});
