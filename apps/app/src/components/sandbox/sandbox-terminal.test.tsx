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
      // First command in a session has no prior cwd to resume from.
      expect(runCommand).toHaveBeenCalledWith("echo hello world", {
        cwd: undefined,
      });
    });
    expect(await screen.findByText("hello world")).toBeTruthy();
    expect(screen.getByText(/exit 0/)).toBeTruthy();
  });

  it("persists the working directory across commands and shows it in the prompt", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(ok({ cwd: "/work/repo" }))
      .mockResolvedValueOnce(ok({ stdout: "file.txt", cwd: "/work/repo" }));
    render(<SandboxTerminal sessionId="sbx_abc123def456" runCommand={runCommand} />);

    typeCommand("cd /work/repo");
    await waitFor(() =>
      expect(runCommand).toHaveBeenNthCalledWith(1, "cd /work/repo", {
        cwd: undefined,
      }),
    );

    // The resulting cwd is now surfaced in the live prompt…
    const prompt = await screen.findByTestId("sandbox-terminal-cwd");
    expect(prompt.textContent).toBe("/work/repo");

    // …and threaded into the next command so `cd` persists.
    typeCommand("ls");
    await waitFor(() =>
      expect(runCommand).toHaveBeenNthCalledWith(2, "ls", { cwd: "/work/repo" }),
    );
  });

  it("keeps the prior cwd when a command reports no cwd (pre-cwd runner)", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(ok({ cwd: "/work" }))
      .mockResolvedValueOnce(ok({ stdout: "no cwd here" })); // runner omits cwd
    render(<SandboxTerminal sessionId="sbx_abc123def456" runCommand={runCommand} />);

    typeCommand("pwd");
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));

    typeCommand("some-tool");
    await waitFor(() =>
      expect(runCommand).toHaveBeenNthCalledWith(2, "some-tool", { cwd: "/work" }),
    );

    // A third command still resumes from /work — the undefined result didn't clobber it.
    typeCommand("again");
    await waitFor(() =>
      expect(runCommand).toHaveBeenNthCalledWith(3, "again", { cwd: "/work" }),
    );
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
