import { describe, expect, it } from "vitest";
import { HandlerError, isHandlerError } from "./handler-error";

describe("HandlerError", () => {
  it("carries a code and a reason, with a default message built from both", () => {
    const err = new HandlerError("not_found", "run_not_found");
    expect(err.code).toBe("not_found");
    expect(err.reason).toBe("run_not_found");
    expect(err.message).toBe("not_found: run_not_found");
    expect(err).toBeInstanceOf(Error);
    expect(isHandlerError(err)).toBe(true);
  });

  it("classifies a structurally equal error from another module copy", () => {
    const copy = Object.assign(new Error("x"), {
      name: "HandlerError",
      code: "conflict",
      reason: "approval_expired",
    });
    expect(isHandlerError(copy)).toBe(true);
  });

  it("refuses an unknown code, a missing reason and a non-error (negative)", () => {
    expect(
      isHandlerError({ name: "HandlerError", code: "teapot", reason: "x" }),
    ).toBe(false);
    expect(isHandlerError({ name: "HandlerError", code: "not_found" })).toBe(
      false,
    );
    expect(isHandlerError(new Error("not_found"))).toBe(false);
    expect(isHandlerError(null)).toBe(false);
    expect(isHandlerError("not_found")).toBe(false);
  });
});
