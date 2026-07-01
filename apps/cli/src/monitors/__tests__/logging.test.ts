/**
 * Background-monitor debug logging (Group 5). Proves the two log-line formats
 * match `monitor-tools.json -> tools[0].logging` byte-for-byte, and that the
 * default sink writes to the `OXAGEN_CLI_DEBUG` stream under the "turn"
 * category with the formatted line carried alongside the structured entry.
 */
import { describe, it, expect, vi, type Mock } from "vitest";

vi.mock("../../lib/debug-log.js", () => ({ debugLog: vi.fn() }));

import { debugLog } from "../../lib/debug-log.js";
import { formatLogLine, defaultLogSink, type MonitorLogEntry } from "../logging.js";

const mockDebug = debugLog as unknown as Mock;

describe("formatLogLine", () => {
  it("formats a dispatch entry exactly per monitor-tools.json", () => {
    const entry: MonitorLogEntry = {
      kind: "dispatch",
      targetType: "gh_actions_run",
      targetId: "123456",
      subagentId: "mon_abc",
      at: "2026-07-01T00:00:00.000Z",
    };
    expect(formatLogLine(entry)).toBe(
      "[monitor] target=gh_actions_run:123456 status=dispatched background=true",
    );
  });

  it("formats a succeeded report entry exactly per monitor-tools.json", () => {
    const entry: MonitorLogEntry = {
      kind: "report",
      targetType: "pull_request",
      targetId: "42",
      status: "succeeded",
      identifiedProblem: false,
      canFixWithCommittedChanges: false,
      note: "",
      subagentId: "mon_abc",
      at: "2026-07-01T00:00:01.000Z",
    };
    expect(formatLogLine(entry)).toBe(
      '[monitor] target=pull_request:42 status=succeeded identified_problem=false can_fix_with_committed_changes=false note=""',
    );
  });

  it("formats a failed report entry with the fix assessment and note", () => {
    const entry: MonitorLogEntry = {
      kind: "report",
      targetType: "ci_job",
      targetId: "job-9",
      status: "failed",
      identifiedProblem: true,
      canFixWithCommittedChanges: true,
      note: "flaky test re-run needed",
      subagentId: "mon_def",
      at: "2026-07-01T00:00:02.000Z",
    };
    expect(formatLogLine(entry)).toBe(
      '[monitor] target=ci_job:job-9 status=failed identified_problem=true can_fix_with_committed_changes=true note="flaky test re-run needed"',
    );
  });
});

describe("defaultLogSink", () => {
  it("writes the dispatch entry to the turn category with the formatted line", () => {
    defaultLogSink({
      kind: "dispatch",
      targetType: "gh_actions_run",
      targetId: "1",
      subagentId: "mon_1",
      at: "2026-07-01T00:00:00.000Z",
    });
    expect(mockDebug).toHaveBeenCalledTimes(1);
    const [category, event, data] = mockDebug.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(category).toBe("turn");
    expect(event).toBe("monitor.dispatch");
    expect(data["line"]).toBe(
      "[monitor] target=gh_actions_run:1 status=dispatched background=true",
    );
    expect(data["targetId"]).toBe("1");
  });

  it("writes the report entry to the turn category with the formatted line", () => {
    defaultLogSink({
      kind: "report",
      targetType: "pull_request",
      targetId: "2",
      status: "failed",
      identifiedProblem: true,
      canFixWithCommittedChanges: false,
      note: "root cause unclear",
      subagentId: "mon_2",
      at: "2026-07-01T00:00:03.000Z",
    });
    expect(mockDebug).toHaveBeenCalledTimes(1);
    const [category, event, data] = mockDebug.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(category).toBe("turn");
    expect(event).toBe("monitor.report");
    expect(data["line"]).toBe(
      '[monitor] target=pull_request:2 status=failed identified_problem=true can_fix_with_committed_changes=false note="root cause unclear"',
    );
  });
});
