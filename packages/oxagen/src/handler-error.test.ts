import { describe, expect, it } from "vitest";
import {
  HANDLER_ERROR_CODES,
  HandlerError,
  isHandlerError,
} from "./handler-error";

describe("HandlerError", () => {
  it("carries the code and reason and is an Error", () => {
    const err = new HandlerError({
      code: "conflict",
      reason: "last_owner",
      message: "Cannot remove the last org owner.",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("HandlerError");
    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("last_owner");
    expect(err.message).toBe("Cannot remove the last org owner.");
  });

  it("defaults the message to code and reason", () => {
    const err = new HandlerError({
      code: "forbidden",
      reason: "insufficient_role",
    });
    expect(err.message).toBe("forbidden: insufficient_role");
  });

  it("exposes exactly the three codes the surfaces map", () => {
    expect([...HANDLER_ERROR_CODES]).toEqual([
      "forbidden",
      "not_found",
      "conflict",
    ]);
  });
});

describe("isHandlerError", () => {
  it("accepts every code the class can carry", () => {
    for (const code of HANDLER_ERROR_CODES) {
      expect(isHandlerError(new HandlerError({ code, reason: "r" }))).toBe(
        true,
      );
    }
  });

  it("accepts a same-shaped Error from another module instance", () => {
    const clone = Object.assign(new Error("m"), {
      code: "not_found",
      reason: "target_not_member",
    });
    expect(isHandlerError(clone)).toBe(true);
  });

  it("refuses an Error with a foreign code", () => {
    const other = Object.assign(new Error("m"), {
      code: "budget_exceeded",
      reason: "r",
    });
    expect(isHandlerError(other)).toBe(false);
  });

  it("refuses an Error carrying a known code without a reason", () => {
    expect(
      isHandlerError(Object.assign(new Error("m"), { code: "conflict" })),
    ).toBe(false);
  });

  it("refuses a plain Error, a non-Error object and null", () => {
    expect(isHandlerError(new Error("m"))).toBe(false);
    expect(isHandlerError({ code: "forbidden", reason: "r" })).toBe(false);
    expect(isHandlerError(null)).toBe(false);
  });
});
