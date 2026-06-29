/**
 * Guards the tool-result error classification and structured-result validation.
 *
 * The earlier error heuristic used `"error" in result`, so a successful result
 * that merely *carries* an `error: null` (or `error: false`) field was wrongly
 * reported as a failure, and the `{ isError: true }` convention was missed
 * entirely. These cases fail on the old code and pass on the hardened version.
 */
import { describe, it, expect } from "vitest";
import {
  structureToolResult,
  parseStructuredToolResult,
} from "../structured-tool-io.js";

describe("structureToolResult error classification", () => {
  it("treats a present-but-empty error field as success", () => {
    expect(structureToolResult("read_file", { error: null }, 5).success).toBe(true);
    expect(structureToolResult("read_file", { error: false }, 5).success).toBe(true);
  });

  it("treats a truthy error field as failure", () => {
    expect(structureToolResult("read_file", { error: "ENOENT" }, 5).success).toBe(false);
  });

  it("honors the isError convention", () => {
    expect(structureToolResult("bash", { isError: true, output: "x" }, 5).success).toBe(false);
    expect(structureToolResult("bash", { isError: false, output: "x" }, 5).success).toBe(true);
  });

  it("treats an Error instance and string output correctly", () => {
    expect(structureToolResult("bash", new Error("boom"), 5).success).toBe(false);
    expect(structureToolResult("read_file", "file contents", 5).success).toBe(true);
  });
});

describe("parseStructuredToolResult", () => {
  it("accepts a well-formed record", () => {
    const ok = structureToolResult("read_file", "hi", 3);
    expect(parseStructuredToolResult(ok)).not.toBeNull();
  });

  it("rejects a malformed record", () => {
    expect(parseStructuredToolResult({ toolName: 42 })).toBeNull();
    expect(parseStructuredToolResult(null)).toBeNull();
    expect(
      parseStructuredToolResult({
        toolName: "x",
        success: true,
        summary: "s",
        data: {},
        metadata: { executionMs: "nope", tokenEstimate: 1 },
      }),
    ).toBeNull();
  });
});
