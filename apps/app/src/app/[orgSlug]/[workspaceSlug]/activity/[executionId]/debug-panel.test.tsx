// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AgentDebugTraceOutput } from "@oxagen/oxagen/contracts/agent.debug.trace";
import { DebugPanel } from "./debug-panel";

afterEach(cleanup);

function baseFrame(): AgentDebugTraceOutput {
  return {
    executionId: "aex_root",
    status: "failed",
    failingStep: {
      stepId: "aes_1",
      stepNumber: 2,
      stepType: "tool_call",
      toolName: "get_ontology_neighbors",
      toolCallId: "atc_1",
      status: "failed",
      failureReason: "tool threw",
      latencyMs: 842,
    },
    errorClass: "TypeError",
    message: "Cannot read properties of undefined (reading 'id')",
    topFrames: [
      {
        functionName: "resolveNode",
        file: "packages/ontology/src/resolve.ts",
        line: 42,
        column: 7,
        internal: false,
        raw: "at resolveNode (packages/ontology/src/resolve.ts:42:7)",
      },
      {
        functionName: null,
        file: "node:internal/process/task_queues",
        line: 95,
        column: 5,
        internal: true,
        raw: "at node:internal/process/task_queues:95:5",
      },
    ],
    relatedSpans: [
      {
        kind: "toolCall",
        id: "atc_1",
        label: "get_ontology_neighbors",
        status: "failed",
        failureReason: "tool threw",
        latencyMs: 842,
      },
      {
        kind: "step",
        id: "aes_1",
        label: "tool_call",
        status: "failed",
        failureReason: "tool threw",
        latencyMs: 900,
      },
    ],
    suspectFiles: [
      {
        path: "packages/ontology/src/resolve.ts",
        score: 8.5,
        reasons: ["stack-frame ×3", "tool-arg"],
      },
    ],
    errorEvents: [
      {
        severity: "error",
        source: "engine",
        errorClass: "TypeError",
        message: "engine caught: undefined property access",
        fingerprint: "fp-1",
        stepId: "aes_1",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    logsSample: [
      {
        level: "error",
        message: "tool call failed",
        stepId: "aes_1",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    diagnosis: null,
    truncated: {
      spans: false,
      frames: false,
      suspectFiles: false,
      errorEvents: false,
      logs: false,
    },
  };
}

describe("DebugPanel", () => {
  it("renders the header, failing step, and related-span summary", () => {
    render(<DebugPanel frame={baseFrame()} />);

    expect(screen.getByTestId("run-debug-panel")).toBeInTheDocument();
    expect(screen.getByText("TypeError")).toBeInTheDocument();
    expect(
      screen.getByText("Cannot read properties of undefined (reading 'id')"),
    ).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText(/tool_call/)).toBeInTheDocument();
    expect(screen.getByText(/get_ontology_neighbors/)).toBeInTheDocument();
    // Related spans: 2 total, 2 failed.
    expect(screen.getByText(/Related spans:/)).toBeInTheDocument();
    expect(screen.getByText(/\(2 failed\)/)).toBeInTheDocument();
  });

  it("renders stack frames and suspect files", () => {
    render(<DebugPanel frame={baseFrame()} />);

    expect(screen.getByText("resolveNode")).toBeInTheDocument();
    expect(screen.getByText(/resolve.ts:42:7/)).toBeInTheDocument();
    expect(screen.getByText("packages/ontology/src/resolve.ts")).toBeInTheDocument();
    expect(screen.getByText("score 8.5")).toBeInTheDocument();
    expect(screen.getByText(/stack-frame ×3, tool-arg/)).toBeInTheDocument();
  });

  it("renders collapsed error-events and logs sections", () => {
    render(<DebugPanel frame={baseFrame()} />);

    expect(screen.getByText("Error events (1)")).toBeInTheDocument();
    expect(screen.getByText(/engine caught: undefined property access/)).toBeInTheDocument();
    expect(screen.getByText("Logs (1)")).toBeInTheDocument();
    // Logs render as one concatenated <pre> block — match a substring.
    expect(screen.getByText(/tool call failed/)).toBeInTheDocument();
  });

  it("renders gracefully when the frame carries no failing step, spans, frames, files, events, or logs", () => {
    const empty: AgentDebugTraceOutput = {
      executionId: "aex_root",
      status: "failed",
      failingStep: null,
      errorClass: null,
      message: null,
      topFrames: [],
      relatedSpans: [],
      suspectFiles: [],
      errorEvents: [],
      logsSample: [],
      diagnosis: null,
      truncated: {
        spans: false,
        frames: false,
        suspectFiles: false,
        errorEvents: false,
        logs: false,
      },
    };

    render(<DebugPanel frame={empty} />);

    // The panel itself still renders — falls back to a generic header label.
    expect(screen.getByTestId("run-debug-panel")).toBeInTheDocument();
    expect(screen.getByText("Execution failed")).toBeInTheDocument();
    // None of the optional sections render.
    expect(screen.queryByText("Stack frames")).not.toBeInTheDocument();
    expect(screen.queryByText("Suspect files")).not.toBeInTheDocument();
    expect(screen.queryByText(/Error events/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Logs/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Failing step:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Related spans:/)).not.toBeInTheDocument();
  });
});
