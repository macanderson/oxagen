import { describe, expect, it } from "vitest";
import { notInGroup, refusalText } from "./index";

/** A server's groups, and the sentence a machine outside them reads. */
const outsiders: [string, string[], string][] = [
  ["one group", ["dev-laptops"], "This machine is not in group dev-laptops."],
  ["two groups", ["dev-laptops", "ci-runners"], "This machine is not in group dev-laptops or ci-runners."],
  ["no group", [], "This machine is not in group (none)."],
];

describe("notInGroup", () => {
  it.each(outsiders)("tells a machine outside %s what to do", (_name, groups, message) => {
    const refusal = notInGroup(groups);
    expect(refusal).toEqual({ code: "not_in_group", message, fix: "Ask a workspace admin to add it." });
    expect(refusalText(refusal)).toBe(`${message} Ask a workspace admin to add it.`);
  });
});
