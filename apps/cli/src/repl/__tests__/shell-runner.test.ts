/**
 * shell-runner — the streaming `!command` executor behind the REPL terminal
 * panel. These exercise the real child process (fast built-ins only) so we
 * prove chunks stream via onData, the exit code is reported, and kill() takes
 * down a long-running command.
 */
import { describe, it, expect } from "vitest";
import { runShellCommand } from "../shell-runner.js";

const cwd = process.cwd();

describe("runShellCommand", () => {
  it("streams stdout and resolves with exit 0", async () => {
    let out = "";
    const handle = runShellCommand({
      command: "echo hello-stream",
      cwd,
      onData: (c) => {
        out += c;
      },
    });
    const res = await handle.done;
    expect(res.exitCode).toBe(0);
    expect(res.killed).toBe(false);
    expect(res.timedOut).toBe(false);
    expect(out).toContain("hello-stream");
  });

  it("captures stderr in the same stream", async () => {
    let out = "";
    const handle = runShellCommand({
      command: "echo oops 1>&2",
      cwd,
      onData: (c) => {
        out += c;
      },
    });
    await handle.done;
    expect(out).toContain("oops");
  });

  it("reports a non-zero exit code", async () => {
    const handle = runShellCommand({ command: "exit 3", cwd, onData: () => {} });
    const res = await handle.done;
    expect(res.exitCode).toBe(3);
  });

  it("kill() terminates a long-running command and reports killed", async () => {
    const handle = runShellCommand({ command: "sleep 30", cwd, onData: () => {} });
    // Let it actually start before killing.
    await new Promise((r) => setTimeout(r, 100));
    handle.kill();
    const res = await handle.done;
    expect(res.killed).toBe(true);
    // A SIGTERM'd process never reaches a clean exit 0.
    expect(res.exitCode).not.toBe(0);
  });
});
