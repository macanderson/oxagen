import { describe, it, expect } from "vitest";
import {
  agentSandboxFileRead,
  SANDBOX_FILE_READ_DEFAULT_MAX_BYTES,
  SANDBOX_FILE_READ_MAX_BYTES,
} from "./agent.sandbox_file.read";
import { getCapability } from "../registry";

describe("agent.sandbox_file.read capability", () => {
  it("is registered under its canonical name", () => {
    expect(getCapability("agent.sandbox_file.read")).toBeDefined();
  });

  it("resolves via the agent.sandbox.files.read alias", () => {
    expect(getCapability("agent.sandbox.files.read")).toBeDefined();
  });

  it("does not gate on billing (a read-only file read consumes no AI tokens)", () => {
    expect(agentSandboxFileRead.noBillingGate).toBe(true);
  });

  it("is a low-risk read that needs no approval", () => {
    expect(agentSandboxFileRead.agent?.requiresApproval).toBe(false);
    expect(agentSandboxFileRead.agent?.riskLevel).toBe("low");
  });

  it("parses minimal valid input and defaults maxBytes to 256 KiB", () => {
    const parsed = agentSandboxFileRead.input.parse({
      sessionId: "sbx_abc123",
      path: "src/index.ts",
    });
    expect(parsed.maxBytes).toBe(SANDBOX_FILE_READ_DEFAULT_MAX_BYTES);
    expect(SANDBOX_FILE_READ_DEFAULT_MAX_BYTES).toBe(256 * 1024);
  });

  it("accepts an explicit maxBytes up to the 1 MiB cap", () => {
    expect(() =>
      agentSandboxFileRead.input.parse({
        sessionId: "sbx_abc123",
        path: "big.bin",
        maxBytes: SANDBOX_FILE_READ_MAX_BYTES,
      }),
    ).not.toThrow();
    expect(SANDBOX_FILE_READ_MAX_BYTES).toBe(1024 * 1024);
  });

  it("rejects input missing sessionId", () => {
    expect(() =>
      agentSandboxFileRead.input.parse({ path: "src/index.ts" }),
    ).toThrow();
  });

  it("rejects input missing path (a read must name its file)", () => {
    expect(() =>
      agentSandboxFileRead.input.parse({ sessionId: "sbx_abc123" }),
    ).toThrow();
  });

  it("rejects an absolute path", () => {
    expect(() =>
      agentSandboxFileRead.input.parse({
        sessionId: "sbx_abc123",
        path: "/etc/passwd",
      }),
    ).toThrow();
  });

  it("rejects a path-traversal segment", () => {
    expect(() =>
      agentSandboxFileRead.input.parse({
        sessionId: "sbx_abc123",
        path: "../../etc/passwd",
      }),
    ).toThrow();
  });

  it("rejects maxBytes above the 1 MiB cap", () => {
    expect(() =>
      agentSandboxFileRead.input.parse({
        sessionId: "sbx_abc123",
        path: "a.txt",
        maxBytes: SANDBOX_FILE_READ_MAX_BYTES + 1,
      }),
    ).toThrow();
  });

  it("rejects a non-positive maxBytes", () => {
    expect(() =>
      agentSandboxFileRead.input.parse({
        sessionId: "sbx_abc123",
        path: "a.txt",
        maxBytes: 0,
      }),
    ).toThrow();
  });

  it("parses a valid utf8 output", () => {
    expect(() =>
      agentSandboxFileRead.output.parse({
        path: "src/index.ts",
        content: "export const x = 1;\n",
        encoding: "utf8",
        sizeBytes: 20,
        truncated: false,
      }),
    ).not.toThrow();
  });

  it("parses a valid base64 (binary) output", () => {
    expect(() =>
      agentSandboxFileRead.output.parse({
        path: "logo.png",
        content: "iVBORw0KGgo=",
        encoding: "base64",
        sizeBytes: 2048,
        truncated: true,
      }),
    ).not.toThrow();
  });

  it("rejects output with an unknown encoding", () => {
    expect(() =>
      agentSandboxFileRead.output.parse({
        path: "a.txt",
        content: "hi",
        encoding: "latin1",
        sizeBytes: 2,
        truncated: false,
      }),
    ).toThrow();
  });

  it("capability has correct defaults", () => {
    expect(agentSandboxFileRead.defaultEffect).toBe("deny");
    expect(agentSandboxFileRead.defaultRoles?.org?.Owner).toBe("allow");
    expect(agentSandboxFileRead.defaultRoles?.org?.Admin).toBe("allow");
    expect(agentSandboxFileRead.defaultRoles?.workspace?.Owner).toBe("allow");
    expect(agentSandboxFileRead.defaultRoles?.workspace?.Member).toBe("allow");
  });
});
