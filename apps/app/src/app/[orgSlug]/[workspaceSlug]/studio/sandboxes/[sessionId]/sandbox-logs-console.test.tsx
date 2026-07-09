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
import type { SandboxLogLine } from "@/lib/studio/sandboxes";

afterEach(cleanup);

const LINES: SandboxLogLine[] = [
  { stream: "stdout", text: "build succeeded" },
  { stream: "stderr", text: "warning: deprecated flag" },
  { stream: "system", text: "$ pnpm build (1.2s)" },
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
      expect(loadLogs).toHaveBeenCalledWith({ level: "normal" });
    });

    const rows = await screen.findAllByTestId("sandbox-logs-line");
    expect(rows).toHaveLength(3);
    expect(screen.getByText("build succeeded")).toBeTruthy();
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

    // Initial load is the non-debug view.
    await waitFor(() =>
      expect(loadLogs).toHaveBeenCalledWith({ level: "normal" }),
    );

    // Toggle Debug ON → the loader is re-called with no level (everything).
    fireEvent.click(screen.getByTestId("sandbox-logs-debug-toggle"));
    await waitFor(() =>
      expect(loadLogs).toHaveBeenLastCalledWith({ level: undefined }),
    );

    // Toggle back OFF → returns to the "normal" view.
    fireEvent.click(screen.getByTestId("sandbox-logs-debug-toggle"));
    await waitFor(() =>
      expect(loadLogs).toHaveBeenLastCalledWith({ level: "normal" }),
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
