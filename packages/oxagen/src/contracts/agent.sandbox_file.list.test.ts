import { describe, it, expect } from "vitest";
import { agentSandboxFilesList } from "./agent.sandbox_file.list";
import { getCapability } from "../registry";

describe("agent.sandbox.files.list capability", () => {
  it("is registered", () => {
    expect(getCapability("list_sandbox_files")).toBeDefined();
  });

  it("does not gate on billing (a read-only listing consumes no AI tokens)", () => {
    expect(agentSandboxFilesList.noBillingGate).toBe(true);
  });

  it("parses minimal valid input (sessionId only) and defaults depth to 2", () => {
    const parsed = agentSandboxFilesList.input.parse({
      sessionId: "sbx_abc123",
    });
    expect(parsed.depth).toBe(2);
    expect(parsed.path).toBeUndefined();
  });

  it("parses valid input with an explicit path and depth", () => {
    expect(() =>
      agentSandboxFilesList.input.parse({
        sessionId: "sbx_abc123",
        path: "src/components",
        depth: 4,
      }),
    ).not.toThrow();
  });

  it("rejects input missing sessionId", () => {
    expect(() => agentSandboxFilesList.input.parse({})).toThrow();
  });

  it("rejects an absolute path", () => {
    expect(() =>
      agentSandboxFilesList.input.parse({
        sessionId: "sbx_abc123",
        path: "/etc/passwd",
      }),
    ).toThrow();
  });

  it("rejects a path-traversal segment", () => {
    expect(() =>
      agentSandboxFilesList.input.parse({
        sessionId: "sbx_abc123",
        path: "../../etc/passwd",
      }),
    ).toThrow();
  });

  it("rejects a depth above the max (5)", () => {
    expect(() =>
      agentSandboxFilesList.input.parse({ sessionId: "sbx_abc123", depth: 6 }),
    ).toThrow();
  });

  it("rejects a depth below the min (1)", () => {
    expect(() =>
      agentSandboxFilesList.input.parse({ sessionId: "sbx_abc123", depth: 0 }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    expect(() =>
      agentSandboxFilesList.output.parse({
        entries: [
          { path: "src", kind: "dir", sizeBytes: 0 },
          { path: "src/index.ts", kind: "file", sizeBytes: 1024 },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects output with an invalid entry kind", () => {
    expect(() =>
      agentSandboxFilesList.output.parse({
        entries: [{ path: "src", kind: "symlink", sizeBytes: 0 }],
      }),
    ).toThrow();
  });

  it("capability has correct defaults", () => {
    expect(agentSandboxFilesList.defaultEffect).toBe("deny");
    expect(agentSandboxFilesList.defaultRoles?.org?.Owner).toBe("allow");
    expect(agentSandboxFilesList.defaultRoles?.org?.Admin).toBe("allow");
    expect(agentSandboxFilesList.defaultRoles?.workspace?.Owner).toBe("allow");
    expect(agentSandboxFilesList.defaultRoles?.workspace?.Member).toBe("allow");
  });
});
