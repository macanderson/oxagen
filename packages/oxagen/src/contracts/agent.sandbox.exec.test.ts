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
    expect(() => agentSandboxExec.input.parse({ sessionId: "sbx_1", command: "" })).toThrow();
    const ok = agentSandboxExec.input.parse({ sessionId: "sbx_1", command: "ls -la" });
    expect(ok.sessionId).toBe("sbx_1");
    expect(ok.command).toBe("ls -la");
  });

  it("defaults timeout to 2 minutes and caps at 10", () => {
    expect(agentSandboxExec.input.parse({ sessionId: "sbx_1", command: "x" }).timeoutMs).toBe(120_000);
    expect(() =>
      agentSandboxExec.input.parse({ sessionId: "sbx_1", command: "x", timeoutMs: 700_000 }),
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

  it("validates the output shape including restored flag", () => {
    const out = agentSandboxExec.output.parse({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      executionMs: 42,
      timedOut: false,
      restored: true,
    });
    expect(out.restored).toBe(true);
    expect(out.executionMs).toBe(42);
  });
});
