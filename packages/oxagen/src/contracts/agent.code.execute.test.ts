import { describe, expect, it } from "vitest";
import { agentCodeExecute } from "./agent.code.execute";
import { getCapability } from "../registry";

describe("agent.code.execute capability", () => {
  it("parses a valid input with defaults", () => {
    const parsed = agentCodeExecute.input.parse({
      language: "node",
      code: "console.log('hi')",
    });
    expect(parsed.timeoutMs).toBe(30_000);
    expect(parsed.memoryMb).toBe(512);
    expect(parsed.network).toBe("deny");
  });

  it("rejects an unknown language", () => {
    expect(() =>
      agentCodeExecute.input.parse({ language: "ruby", code: "puts" }),
    ).toThrow();
  });

  it("rejects empty code", () => {
    expect(() =>
      agentCodeExecute.input.parse({ language: "node", code: "" }),
    ).toThrow();
  });

  it("rejects a timeout above the cap", () => {
    expect(() =>
      agentCodeExecute.input.parse({
        language: "node",
        code: "x",
        timeoutMs: 600_000,
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentCodeExecute.output.parse({
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      durationMs: 12,
      timedOut: false,
      oomKilled: false,
    });
    expect(parsed.exitCode).toBe(0);
  });

  it("rejects a negative durationMs", () => {
    expect(() =>
      agentCodeExecute.output.parse({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: -1,
        timedOut: false,
        oomKilled: false,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.code.execute")).toBe(agentCodeExecute);
  });
});
