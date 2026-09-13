import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type Read,
  type ReadFailure,
  denied,
  notBacked,
  readError,
  readOk,
} from "./not-backed";

describe("Read helpers", () => {
  it("notBacked names the milestone and gap", () => {
    expect(notBacked("M2", "G3")).toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M2",
      gap: "G3",
    });
  });

  it("readOk, readError and denied build the other three arms", () => {
    expect(readOk([1, 2])).toEqual({ ok: true, value: [1, 2] });
    expect(readError("run_index_unavailable", 503)).toEqual({
      ok: false,
      reason: "error",
      code: "run_index_unavailable",
      status: 503,
    });
    expect(denied("runs.read")).toEqual({
      ok: false,
      reason: "denied",
      permission: "runs.read",
    });
  });

  it("narrows on ok and reason", () => {
    const read = notBacked("M1", "G6") as Read<string>;
    if (read.ok) {
      expectTypeOf(read.value).toEqualTypeOf<string>();
      throw new Error("a not-backed read is never ok");
    }
    expectTypeOf(read).toEqualTypeOf<ReadFailure>();
    expect(read.reason).toBe("not_backed");
  });
});
