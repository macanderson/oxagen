// @vitest-environment jsdom
/**
 * sandbox-env-panel.test.tsx
 *
 * Covers the environment panel: showing the image's runtimes, adding package
 * chips, composing the right install command through the injected runner, and
 * rejecting shell-active tokens before anything runs.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { SandboxEnvPanel } from "./sandbox-env-panel";
import type { SandboxExecResult } from "./sandbox-terminal";

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

function addToken(value: string) {
  const input = screen.getByTestId("sandbox-pkg-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("SandboxEnvPanel", () => {
  it("shows the image's baked runtimes", () => {
    render(<SandboxEnvPanel image="node" runCommand={vi.fn()} />);
    expect(screen.getByText("Node.js 20")).toBeTruthy();
  });

  it("adds a chip and installs via npm through the injected runner", async () => {
    const runCommand = vi.fn(async () => ok({ stdout: "added 2 packages" }));
    render(<SandboxEnvPanel image="node" runCommand={runCommand} />);

    addToken("express");
    addToken("zod");
    expect(screen.getAllByTestId("sandbox-pkg-chip")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("sandbox-pkg-install"));

    await waitFor(() =>
      expect(runCommand).toHaveBeenCalledWith("npm install express zod"),
    );
    expect(await screen.findByText("Installed")).toBeTruthy();
    // A clean install clears the chips for the next batch.
    expect(screen.queryAllByTestId("sandbox-pkg-chip")).toHaveLength(0);
  });

  it("composes a pip install for a python image", async () => {
    const runCommand = vi.fn(async () => ok());
    render(<SandboxEnvPanel image="python" runCommand={runCommand} />);
    addToken("requests");
    fireEvent.click(screen.getByTestId("sandbox-pkg-install"));
    await waitFor(() =>
      expect(runCommand).toHaveBeenCalledWith("pip install requests"),
    );
  });

  it("rejects a shell-active token and never runs a command", async () => {
    const runCommand = vi.fn(async () => ok());
    render(<SandboxEnvPanel image="node" runCommand={runCommand} />);
    addToken("express; rm -rf /");
    expect(screen.getByRole("alert").textContent).toMatch(/not a valid/i);
    expect(screen.queryAllByTestId("sandbox-pkg-chip")).toHaveLength(0);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("surfaces a non-zero install as a failure", async () => {
    const runCommand = vi.fn(async () =>
      ok({ exitCode: 1, stderr: "E404 Not Found" }),
    );
    render(<SandboxEnvPanel image="node" runCommand={runCommand} />);
    addToken("nope-not-real");
    fireEvent.click(screen.getByTestId("sandbox-pkg-install"));
    expect(await screen.findByText(/Install failed \(exit 1\)/)).toBeTruthy();
  });

  it("disables installing when the session is not runnable", () => {
    render(<SandboxEnvPanel image="node" runCommand={vi.fn()} disabled />);
    expect(
      (screen.getByTestId("sandbox-pkg-install") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
