import { describe, expect, it } from "vitest";
import { agentSandboxExec } from "./agent.sandbox.exec";
import { getCapability } from "../registry";

describe("agent.sandbox.exec capability", () => {
  it("is registered and scoped", () => {
    const cap = getCapability("run_sandbox_command");
    expect(cap?.domain).toBe("agent");
    expect(cap?.scoped).toBe(true);
  });

  it("requires a sessionId and a non-empty command", () => {
    expect(() => agentSandboxExec.input.parse({ command: "ls" })).toThrow();
    expect(() =>
      agentSandboxExec.input.parse({ sessionId: "sbx_1", command: "" }),
    ).toThrow();
    const ok = agentSandboxExec.input.parse({
      sessionId: "sbx_1",
      command: "ls -la",
    });
    expect(ok.sessionId).toBe("sbx_1");
    expect(ok.command).toBe("ls -la");
  });

  it("defaults timeout to 2 minutes and caps at 10", () => {
    expect(
      agentSandboxExec.input.parse({ sessionId: "sbx_1", command: "x" })
        .timeoutMs,
    ).toBe(120_000);
    expect(() =>
      agentSandboxExec.input.parse({
        sessionId: "sbx_1",
        command: "x",
        timeoutMs: 700_000,
      }),
    ).toThrow();
  });

  it("strips reserved/host env keys via the shared sanitizer", () => {
    const parsed = agentSandboxExec.input.parse({
      sessionId: "sbx_1",
      command: "env",
      env: { SAFE: "ok", PATH: "/evil", MODAL_TOKEN: "stolen", "bad-key": "x" },
    });
    expect(parsed.env).toEqual({ SAFE: "ok" });
  });

  it("accepts an optional cwd and rejects an over-long one", () => {
    const withCwd = agentSandboxExec.input.parse({
      sessionId: "sbx_1",
      command: "ls",
      cwd: "/work/repo/src",
    });
    expect(withCwd.cwd).toBe("/work/repo/src");
    // Omitted cwd is fine (first command in a session).
    expect(
      agentSandboxExec.input.parse({ sessionId: "sbx_1", command: "ls" }).cwd,
    ).toBeUndefined();
    expect(() =>
      agentSandboxExec.input.parse({
        sessionId: "sbx_1",
        command: "ls",
        cwd: "x".repeat(4_097),
      }),
    ).toThrow();
  });

  it("validates the output shape including restored flag and cwd", () => {
    const out = agentSandboxExec.output.parse({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      executionMs: 42,
      timedOut: false,
      restored: true,
      cwd: "/work/repo",
    });
    expect(out.restored).toBe(true);
    expect(out.executionMs).toBe(42);
    expect(out.cwd).toBe("/work/repo");
    // cwd is nullable — null means "not captured", the caller keeps its prior dir.
    expect(
      agentSandboxExec.output.parse({
        exitCode: 0,
        stdout: "",
        stderr: "",
        executionMs: 1,
        timedOut: false,
        restored: false,
        cwd: null,
      }).cwd,
    ).toBeNull();
  });
});
