// @vitest-environment jsdom
/**
 * sandbox-terminal.test.tsx
 *
 * Covers the interactive terminal: running a command via the injected runner,
 * rendering stdout/stderr + exit code, surfacing a thrown runner as an error
 * entry, the disabled state, and ↑ command-history recall.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { SandboxTerminal, type SandboxExecResult } from "./sandbox-terminal";

afterEach(cleanup);

function ok(partial: Partial<SandboxExecResult> = {}): SandboxExecResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    executionMs: 10,
    timedOut: false,
    restored: false,
    ...partial,
  };
}

function typeCommand(value: string) {
  const input = screen.getByTestId("sandbox-terminal-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
  return input;
}

describe("SandboxTerminal", () => {
  it("runs a command and renders its stdout + exit code", async () => {
    const runCommand = vi.fn(async () => ok({ stdout: "hello world" }));
    render(<SandboxTerminal sessionId="sbx_abc123def456" runCommand={runCommand} />);

    typeCommand("echo hello world");

    await waitFor(() => {
      expect(runCommand).toHaveBeenCalledWith("echo hello world");
    });
    expect(await screen.findByText("hello world")).toBeTruthy();
    expect(screen.getByText(/exit 0/)).toBeTruthy();
  });

  it("renders a non-zero exit and stderr", async () => {
    const runCommand = vi.fn(async () =>
      ok({ stderr: "boom", exitCode: 2 }),
    );
    render(<SandboxTerminal sessionId="sbx_abc123def456" runCommand={runCommand} />);

    typeCommand("false");

    expect(await screen.findByText("boom")).toBeTruthy();
    expect(screen.getByText(/exit 2/)).toBeTruthy();
  });

  it("surfaces a thrown runner as an error entry, not a crash", async () => {
    const runCommand = vi.fn(async () => {
      throw new Error("sandbox gone");
    });
    render(<SandboxTerminal sessionId="sbx_abc123def456" runCommand={runCommand} />);

    typeCommand("ls");

    expect(await screen.findByText("sandbox gone")).toBeTruthy();
    expect(screen.getByText(/error/)).toBeTruthy();
  });

  it("does not run when disabled", () => {
    const runCommand = vi.fn(async () => ok());
    render(
      <SandboxTerminal
        sessionId="sbx_abc123def456"
        runCommand={runCommand}
        disabled
      />,
    );
    const input = screen.getByTestId("sandbox-terminal-input") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "ls" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("recalls the previous command with ArrowUp", async () => {
    const runCommand = vi.fn(async () => ok({ stdout: "done" }));
    render(<SandboxTerminal sessionId="sbx_abc123def456" runCommand={runCommand} />);

    const input = typeCommand("git status") as HTMLInputElement;
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("git status");
  });

  it("seeds scrollback from initialHistory", () => {
    render(
      <SandboxTerminal
        sessionId="sbx_abc123def456"
        runCommand={vi.fn(async () => ok())}
        initialHistory={[
          {
            command: "cat file",
            status: "done",
            stdout: "contents",
            stderr: "",
            exitCode: 0,
            executionMs: 5,
            timedOut: false,
          },
        ]}
      />,
    );
    expect(screen.getByText("cat file")).toBeTruthy();
    expect(screen.getByText("contents")).toBeTruthy();
  });
});
