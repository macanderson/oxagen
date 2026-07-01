import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultLogSink, formatLogLine } from "../logging.js";
import * as debug from "../../lib/debug-log.js";

describe("orchestrator logging", () => {
  describe("formatLogLine", () => {
    it("formats a worker route line per routing-policy.json", () => {
      const line = formatLogLine({
        kind: "route",
        complexity: "medium",
        promptTokens: 800,
        selected: "sonnet-5",
        coordinator: false,
        reason: "cheapest capable code worker",
      });
      expect(line).toBe(
        '[route] complexity=medium prompt_tokens=800 selected=sonnet-5 coordinator=false reason="cheapest capable code worker"',
      );
    });

    it("uses the kept-trivial template when coordinator is true", () => {
      const line = formatLogLine({
        kind: "route",
        complexity: "low",
        promptTokens: 40,
        selected: "on-device",
        coordinator: true,
        reason: "trivial, no dispatch",
      });
      expect(line).toBe('[route] complexity=low selected=coordinator reason="trivial, no dispatch"');
    });

    it("formats a dispatch line and collapses whitespace in the task", () => {
      const line = formatLogLine({
        kind: "dispatch",
        worker: "sonnet-5",
        task: "add\n  a  route",
        estTokens: 1200,
      });
      expect(line).toBe('[dispatch] worker=sonnet-5 task="add a route" est_tokens=1200');
    });

    it("truncates a very long task string", () => {
      const line = formatLogLine({
        kind: "dispatch",
        worker: "opus",
        task: "x".repeat(500),
        estTokens: 1,
      });
      expect(line).toContain("…");
      expect(line.length).toBeLessThan(200);
    });
  });

  describe("defaultLogSink", () => {
    const saved = process.env["OXAGEN_CLI_DEBUG"];
    beforeEach(() => {
      process.env["OXAGEN_CLI_DEBUG"] = "1";
    });
    afterEach(() => {
      if (saved === undefined) delete process.env["OXAGEN_CLI_DEBUG"];
      else process.env["OXAGEN_CLI_DEBUG"] = saved;
      vi.restoreAllMocks();
    });

    it("writes the entry and its formatted line to the debug stream", () => {
      const spy = vi.spyOn(debug, "debugLog").mockResolvedValue();
      defaultLogSink({
        kind: "route",
        complexity: "high",
        promptTokens: 10,
        selected: "opus",
        coordinator: false,
        reason: "upgrade",
      });
      expect(spy).toHaveBeenCalledWith(
        "turn",
        "orchestrator.route",
        expect.objectContaining({ selected: "opus", line: expect.stringContaining("[route]") }),
      );
    });
  });
});
