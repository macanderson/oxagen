// @vitest-environment jsdom
/**
 * sandbox-logs-console.test.tsx
 *
 * Covers the captured-output console: it loads via the injected loader on
 * mount at `level: "normal"`, renders each line with its stream tag, and the
 * Debug toggle flips the verbosity the loader is called with (OFF → "normal",
 * ON → no level). The injected `loadLogs` stands in for the real
 * `list_sandbox_logs` server action, so asserting on its args proves the wiring.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { SandboxLogsConsole } from "./sandbox-logs-console";
import type { SandboxLogLine } from "@/lib/workbench/sandboxes";

afterEach(cleanup);

// The real `list_sandbox_logs` shape — `line` holds the text (not `text`), and
// the closing `system` line carries exitCode + durationMs as separate columns.
const LINES: SandboxLogLine[] = [
  {
    ts: "2026-07-10T00:00:00.000Z",
    stream: "stdout",
    level: "normal",
    command: "pnpm build",
    seq: 1,
    line: "build succeeded",
    exitCode: null,
    durationMs: null,
  },
  {
    ts: "2026-07-10T00:00:01.000Z",
    stream: "stderr",
    level: "normal",
    command: "pnpm build",
    seq: 2,
    line: "warning: deprecated flag",
    exitCode: null,
    durationMs: null,
  },
  {
    ts: "2026-07-10T00:00:02.000Z",
    stream: "system",
    level: "debug",
    command: "pnpm build",
    seq: 3,
    line: "$ pnpm build",
    exitCode: 0,
    durationMs: 1200,
  },
];

// A large poll interval keeps the live-tail timer from firing mid-assertion.
const NO_POLL = 10_000_000;

describe("SandboxLogsConsole", () => {
  it("loads at level 'normal' on mount and renders each stream-tagged line", async () => {
    const loadLogs = vi.fn(async () => LINES);
    render(
      <SandboxLogsConsole
        sessionId="sbx_abc123def456"
        loadLogs={loadLogs}
        pollMs={NO_POLL}
      />,
    );

    await waitFor(() => {
      expect(loadLogs).toHaveBeenCalledWith({ level: "normal", limit: 500 });
    });

    const rows = await screen.findAllByTestId("sandbox-logs-line");
    expect(rows).toHaveLength(3);
    // The captured text renders (regression: it was read from a non-existent
    // `line.text` and every row came out blank).
    expect(screen.getByText("build succeeded")).toBeTruthy();
    expect(screen.getByText("warning: deprecated flag")).toBeTruthy();
    // The system line surfaces its exit code + duration instead of dropping them.
    expect(screen.getByText(/exit 0 · 1\.2s/)).toBeTruthy();
    // Stream tags render for each pipe.
    expect(screen.getByText("[stdout]")).toBeTruthy();
    expect(screen.getByText("[stderr]")).toBeTruthy();
    expect(screen.getByText("[system]")).toBeTruthy();
  });

  it("flips the level passed to the loader when Debug is toggled on", async () => {
    const loadLogs = vi.fn(async () => LINES);
    render(
      <SandboxLogsConsole
        sessionId="sbx_abc123def456"
        loadLogs={loadLogs}
        pollMs={NO_POLL}
      />,
    );

    // Initial load is the non-debug view. Every call carries the row cap.
    await waitFor(() =>
      expect(loadLogs).toHaveBeenCalledWith({ level: "normal", limit: 500 }),
    );

    // Toggle Debug ON → the loader is re-called with no level (everything).
    fireEvent.click(screen.getByTestId("sandbox-logs-debug-toggle"));
    await waitFor(() =>
      expect(loadLogs).toHaveBeenLastCalledWith({
        level: undefined,
        limit: 500,
      }),
    );

    // Toggle back OFF → returns to the "normal" view.
    fireEvent.click(screen.getByTestId("sandbox-logs-debug-toggle"));
    await waitFor(() =>
      expect(loadLogs).toHaveBeenLastCalledWith({
        level: "normal",
        limit: 500,
      }),
    );
  });

  it("surfaces a loader failure as an error rather than crashing", async () => {
    const loadLogs = vi.fn(async () => {
      throw new Error("sandbox gone");
    });
    render(
      <SandboxLogsConsole
        sessionId="sbx_abc123def456"
        loadLogs={loadLogs}
        pollMs={NO_POLL}
      />,
    );
    expect(await screen.findByText("sandbox gone")).toBeTruthy();
  });

  it("keeps loaded lines and shows an inline error banner when a refresh fails", async () => {
    // First load succeeds; the next (Refresh-triggered) load throws. A transient
    // poll failure must NOT wipe the scrollback — the lines stay, the error is a
    // banner alongside them.
    const loadLogs = vi.fn(async () => LINES);
    render(
      <SandboxLogsConsole
        sessionId="sbx_abc123def456"
        loadLogs={loadLogs}
        pollMs={NO_POLL}
      />,
    );

    const rows = await screen.findAllByTestId("sandbox-logs-line");
    expect(rows).toHaveLength(3);

    // Queue a one-time failure for the manual refresh.
    loadLogs.mockRejectedValueOnce(new Error("poll failed"));
    fireEvent.click(screen.getByTestId("sandbox-logs-refresh"));

    expect(await screen.findByRole("alert")).toHaveTextContent("poll failed");
    // The previously-loaded lines are still on screen.
    expect(screen.getAllByTestId("sandbox-logs-line")).toHaveLength(3);
  });

  it("does not load when disabled", () => {
    const loadLogs = vi.fn(async () => LINES);
    render(
      <SandboxLogsConsole
        sessionId="sbx_abc123def456"
        loadLogs={loadLogs}
        disabled
        pollMs={NO_POLL}
      />,
    );
    expect(loadLogs).not.toHaveBeenCalled();
    expect(screen.getByText(/Logs are unavailable/)).toBeTruthy();
  });
});
