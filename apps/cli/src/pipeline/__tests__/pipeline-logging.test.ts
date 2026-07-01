import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPipelineLogSink, formatPipelineLine } from "../pipeline-logging.js";
import * as debug from "../../lib/debug-log.js";

describe("pipeline logging", () => {
  it("formats the [graph] line per pipeline-config.json", () => {
    expect(
      formatPipelineLine({ kind: "graph", query: "failing job fix", returnedFiles: 4, coverage: 0.88, source: "graphrag" }),
    ).toBe('[graph] query="failing job fix" returned_files=4 coverage=0.88 source=graphrag');
  });

  it("formats a plan step line", () => {
    expect(
      formatPipelineLine({ kind: "step", step: 3, label: "tool=plan", status: "done", fields: [["tasks", 3]] }),
    ).toBe("[pipeline] step=3 tool=plan status=done tasks=3");
  });

  it("formats a verify step line with an evidence list", () => {
    expect(
      formatPipelineLine({ kind: "step", step: 4, label: "verify", status: "done", fields: [["evidence", "[test.log, screenshot.png]"]] }),
    ).toBe('[pipeline] step=4 verify status=done evidence="[test.log, screenshot.png]"');
  });

  it("formats a judge step line with worker/judge models", () => {
    expect(
      formatPipelineLine({ kind: "step", step: 5, label: "tool=judge", status: "start", fields: [["worker_model", "sonnet-5"], ["judge_model", "openai-most-capable-coding-model"]] }),
    ).toBe('[pipeline] step=5 tool=judge status=start worker_model="sonnet-5" judge_model="openai-most-capable-coding-model"');
  });

  it("omits the field segment when there are no fields", () => {
    expect(formatPipelineLine({ kind: "step", step: 2, label: "route", status: "done" })).toBe(
      "[pipeline] step=2 route status=done",
    );
  });

  describe("defaultPipelineLogSink", () => {
    const saved = process.env["OXAGEN_CLI_DEBUG"];
    beforeEach(() => (process.env["OXAGEN_CLI_DEBUG"] = "1"));
    afterEach(() => {
      if (saved === undefined) delete process.env["OXAGEN_CLI_DEBUG"];
      else process.env["OXAGEN_CLI_DEBUG"] = saved;
      vi.restoreAllMocks();
    });

    it("writes the entry and its formatted line to the debug stream", () => {
      const spy = vi.spyOn(debug, "debugLog").mockResolvedValue();
      defaultPipelineLogSink({ kind: "graph", query: "q", returnedFiles: 1, coverage: 0.5, source: "grep-fallback" });
      expect(spy).toHaveBeenCalledWith(
        "turn",
        "pipeline.graph",
        expect.objectContaining({ line: expect.stringContaining("[graph]") }),
      );
    });
  });
});
