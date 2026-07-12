import { describe, it, expect } from "vitest";
import {
  fanoutStatusVariant,
  isFanoutCancellable,
  runStatusVariant,
} from "./status";

describe("fanoutStatusVariant", () => {
  it.each([
    ["completed", "success"],
    ["running", "info"],
    ["pending", "muted"],
    ["partial", "warning"],
    ["timed_out", "warning"],
    ["something_unknown", "muted"],
  ] as const)("%s -> %s", (status, expected) => {
    expect(fanoutStatusVariant(status)).toBe(expected);
  });
});

describe("runStatusVariant", () => {
  it.each([
    ["completed", "success"],
    ["running", "info"],
    ["failed", "error"],
    ["pending", "muted"],
    ["something_unknown", "muted"],
  ] as const)("%s -> %s", (status, expected) => {
    expect(runStatusVariant(status)).toBe(expected);
  });
});

describe("isFanoutCancellable", () => {
  it("is true for pending and running", () => {
    expect(isFanoutCancellable("pending")).toBe(true);
    expect(isFanoutCancellable("running")).toBe(true);
  });

  it("is false for terminal statuses", () => {
    expect(isFanoutCancellable("completed")).toBe(false);
    expect(isFanoutCancellable("partial")).toBe(false);
    expect(isFanoutCancellable("timed_out")).toBe(false);
  });
});
