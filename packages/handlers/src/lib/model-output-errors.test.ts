// model-output-errors.test.ts: an answer that did not parse is told from an
// outage by the AI SDK error's name.
import { describe, expect, it } from "vitest";
import { isOutputParseError } from "./model-output-errors";

function named(name: string): Error {
  const error = new Error("parse");
  error.name = name;
  return error;
}

describe("isOutputParseError", () => {
  it("reads the AI SDK's parse errors by name", () => {
    expect(isOutputParseError(named("AI_NoObjectGeneratedError"))).toBe(true);
    expect(isOutputParseError(named("AI_TypeValidationError"))).toBe(true);
    expect(isOutputParseError(named("AI_JSONParseError"))).toBe(true);
  });

  it("reads any other error as an outage", () => {
    expect(isOutputParseError(named("AI_APICallError"))).toBe(false);
    expect(isOutputParseError(new Error("credit admission refused"))).toBe(false);
  });

  it("reads only errors, not a string that holds a name", () => {
    expect(isOutputParseError("AI_JSONParseError")).toBe(false);
    expect(isOutputParseError({ name: "AI_JSONParseError" })).toBe(false);
  });
});
