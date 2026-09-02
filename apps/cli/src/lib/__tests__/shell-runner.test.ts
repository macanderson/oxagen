/**
 * shell-runner — the streaming `!command` executor behind the REPL terminal
 * panel. These exercise the real child process (fast built-ins only) so we
 * prove chunks stream via onData, the exit code is reported, and kill() takes
 * down a long-running command.
 */
import { describe, it, expect } from "vitest";
import { runShellCommand, runShellCommandBuffered } from "../shell-runner.js";

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
    const handle = runShellCommand({
      command: "exit 3",
      cwd,
      onData: () => {},
    });
    const res = await handle.done;
    expect(res.exitCode).toBe(3);
  });

  it("kill() terminates a long-running command and reports killed", async () => {
    const handle = runShellCommand({
      command: "sleep 30",
      cwd,
      onData: () => {},
    });
    // Let it actually start before killing.
    await new Promise((r) => setTimeout(r, 100));
    handle.kill();
    const res = await handle.done;
    expect(res.killed).toBe(true);
    // A SIGTERM'd process never reaches a clean exit 0.
    expect(res.exitCode).not.toBe(0);
  });
});

describe("runShellCommandBuffered", () => {
  it("captures stdout and resolves with exit 0", async () => {
    const res = await runShellCommandBuffered({
      command: "echo hi-buffered",
      cwd,
    });
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toContain("hi-buffered");
  });

  it("separates stderr from stdout", async () => {
    const res = await runShellCommandBuffered({
      command: "echo out; echo err 1>&2",
      cwd,
    });
    expect(res.stdout).toContain("out");
    expect(res.stderr).toContain("err");
    expect(res.stdout).not.toContain("err");
  });

  it("reports a non-zero exit code", async () => {
    const res = await runShellCommandBuffered({ command: "exit 7", cwd });
    expect(res.exitCode).toBe(7);
    expect(res.timedOut).toBe(false);
  });

  it("times out and reports timedOut instead of hanging", async () => {
    const start = Date.now();
    const res = await runShellCommandBuffered({
      command: "sleep 30",
      cwd,
      timeoutMs: 300,
    });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it("REGRESSION: times out even when a grandchild keeps the stdout pipe open", async () => {
    // The original hang: `bash -c` spawns a backgrounded child that inherits the
    // stdout pipe and outlives the shell. Node's `exec({ timeout })` signals only
    // the shell, so the pipe never EOFs and the promise never settles. Killing
    // the whole process group must let this resolve within the timeout window.
    const start = Date.now();
    const res = await runShellCommandBuffered({
      command: "sleep 30 & echo started; wait",
      cwd,
      timeoutMs: 500,
    });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});

describe("runShellCommandBuffered — abort signal", () => {
  it("kills the process group when the signal fires mid-run (does not wait for timeout)", async () => {
    const ac = new AbortController();
    const start = Date.now();
    const p = runShellCommandBuffered({
      command: "sleep 30 & echo started; wait",
      cwd,
      timeoutMs: 60_000, // long — the abort, not the timeout, must end it
      signal: ac.signal,
    });
    // Abort shortly after it starts.
    setTimeout(() => ac.abort(), 200);
    const res = await p;
    // Resolved well before the 60s timeout because the abort killed the subtree.
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(res.exitCode).toBeGreaterThanOrEqual(1);
  });

  it("never spawns when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    const res = await runShellCommandBuffered({
      command: "echo should-not-run",
      cwd,
      signal: ac.signal,
    });
    expect(res.exitCode).toBe(124);
    expect(res.stdout).toBe("");
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
