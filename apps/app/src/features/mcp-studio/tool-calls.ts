// How many of a server's imported tools agents called over the feedback
// window (spend detector 2's finding: "Agents called <k> of its <m> tools
// this month"). The counts are get_studio_server's per-key feedback
// (ADR-234), over the record's `feedbackWindowDays`, 30 today.
//
// A tool counts only when its call count is recorded. A key with no feedback,
// or whose counts the call store did not answer for, is left out of both
// numbers and counted apart, so a tool Oxagen cannot see never reads as a
// tool no agent called.
import type { StudioRecord, StudioTool } from "./model";

type ToolCalls =
  /** No record, or no imported tool has a recorded call count. */
  | { kind: "notRecorded" }
  /** The server imports no tool, so there is nothing to count. */
  | { kind: "none" }
  | {
      kind: "recorded";
      /** Imported tools agents called at least once in the window. */
      called: number;
      /** Imported tools with a recorded call count. */
      counted: number;
      /** Imported tools with a recorded count of zero, in the table's order. */
      uncalled: readonly string[];
      /** Imported tools with no recorded count. */
      unrecorded: number;
      windowDays: number;
    };

export function toolCalls(
  record: StudioRecord | null,
  tools: readonly Pick<StudioTool, "name" | "imported" | "feedback">[],
): ToolCalls {
  const imported = tools.filter((tool) => tool.imported);
  if (record === null) return { kind: "notRecorded" };
  if (imported.length === 0) return { kind: "none" };
  const counted = imported.flatMap((tool) => {
    const counts = tool.feedback?.counts ?? null;
    return counts === null ? [] : [{ name: tool.name, calls: counts.calls }];
  });
  if (counted.length === 0) return { kind: "notRecorded" };
  return {
    kind: "recorded",
    called: counted.filter((tool) => tool.calls > 0).length,
    counted: counted.length,
    uncalled: counted.filter((tool) => tool.calls === 0).map((tool) => tool.name),
    unrecorded: imported.length - counted.length,
    windowDays: record.feedbackWindowDays,
  };
}
