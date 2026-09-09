import { describe, expect, it } from "vitest";

import {
  ExecutionNotFoundError,
  isExecutionNotFoundError,
} from "./execution-errors";

describe("ExecutionNotFoundError", () => {
  it("carries the execution id, a stable code, and a readable message", () => {
    const err = new ExecutionNotFoundError("exec_1");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ExecutionNotFoundError");
    expect(err.code).toBe("execution_not_found");
    expect(err.executionId).toBe("exec_1");
    expect(err.message).toBe("Execution exec_1 not found");
  });
});

describe("isExecutionNotFoundError", () => {
  it("matches an instance of the class", () => {
    expect(isExecutionNotFoundError(new ExecutionNotFoundError("e"))).toBe(
      true,
    );
  });

  it("matches structurally across a package boundary via the code field", () => {
    const foreign = Object.assign(new Error("Execution e not found"), {
      code: "execution_not_found",
    });
    expect(isExecutionNotFoundError(foreign)).toBe(true);
  });

  it("rejects an Error carrying a different code", () => {
    const other = Object.assign(new Error("nope"), { code: "other" });
    expect(isExecutionNotFoundError(other)).toBe(false);
  });

  it("rejects a plain Error and non-Error values", () => {
    expect(isExecutionNotFoundError(new Error("nope"))).toBe(false);
    expect(isExecutionNotFoundError({ code: "execution_not_found" })).toBe(
      false,
    );
    expect(isExecutionNotFoundError(null)).toBe(false);
  });
});
