// How many of a server's imported tools agents called over the feedback
// window, and which ones they did not (spend detector 2's finding line).
import { describe, expect, it } from "vitest";
import type { StudioTool } from "./model";
import { stripeRecord, studioTool } from "./studio.builders";
import { toolCalls } from "./tool-calls";

const RECORD = { ...stripeRecord(), feedbackWindowDays: 30 };

/** An imported tool whose call count over the window is `calls`. */
function called(name: string, calls: number): StudioTool {
  return studioTool(name, {
    feedback: {
      counts: { calls, schemaRejections: 0, errorResults: 0, retries: 0 },
      notes: [],
    },
  });
}

describe("toolCalls", () => {
  it("counts the imported tools agents called and names the ones they did not", () => {
    const tools = [
      called("create_payment", 1_204),
      called("list_customers", 0),
      called("list_prices", 3),
      called("void_invoice", 0),
      // A tool nobody imported is not counted, whatever its feedback says.
      { ...called("create_coupon", 0), imported: false },
    ];
    expect(toolCalls(RECORD, tools)).toEqual({
      kind: "recorded",
      called: 2,
      counted: 4,
      uncalled: ["list_customers", "void_invoice"],
      unrecorded: 0,
      windowDays: 30,
    });
  });

  it("leaves a tool with no recorded count out of both numbers and counts it apart", () => {
    const tools = [
      called("create_payment", 12),
      studioTool("list_customers"),
      studioTool("list_prices", { feedback: { counts: null, notes: ["Slow."] } }),
    ];
    expect(toolCalls(RECORD, tools)).toEqual({
      kind: "recorded",
      called: 1,
      counted: 1,
      uncalled: [],
      unrecorded: 2,
      windowDays: 30,
    });
  });

  it("takes the window the record gives", () => {
    const result = toolCalls({ ...RECORD, feedbackWindowDays: 7 }, [called("a_tool", 1)]);
    expect(result).toMatchObject({ kind: "recorded", windowDays: 7 });
  });

  it("is not recorded with no record, or when no imported tool has a count", () => {
    expect(toolCalls(null, [called("create_payment", 4)])).toEqual({ kind: "notRecorded" });
    expect(
      toolCalls(RECORD, [studioTool("create_payment"), studioTool("list_customers")]),
    ).toEqual({ kind: "notRecorded" });
  });

  it("has nothing to count when the server imports no tool", () => {
    expect(
      toolCalls(RECORD, [{ ...called("create_coupon", 0), imported: false }]),
    ).toEqual({ kind: "none" });
  });
});
