import { describe, expect, it } from "vitest";
import { agentFileLockAcquire } from "./agent.file.lock.acquire";
import { getCapability } from "../registry";

describe("agent.file.lock.acquire capability", () => {
  it("requires a path", () => {
    expect(() => agentFileLockAcquire.input.parse({})).toThrow();
  });

  it("parses a minimal input", () => {
    const parsed = agentFileLockAcquire.input.parse({ path: "src/a.ts" });
    expect(parsed.path).toBe("src/a.ts");
  });

  it("parses a fully-specified input", () => {
    const parsed = agentFileLockAcquire.input.parse({
      path: "src/a.ts",
      owner: "oxageninc",
      repo: "oxagen-platform",
      action: "write",
      ttlMs: 60_000,
      agentId: "agent-a",
      executionId: "turn-1",
    });
    expect(parsed).toMatchObject({
      path: "src/a.ts",
      owner: "oxageninc",
      repo: "oxagen-platform",
      action: "write",
      ttlMs: 60_000,
      agentId: "agent-a",
      executionId: "turn-1",
    });
  });

  it("rejects ttlMs above the 1-hour cap", () => {
    expect(() => agentFileLockAcquire.input.parse({ path: "a.ts", ttlMs: 3_600_001 })).toThrow();
  });

  it("rejects an invalid action", () => {
    expect(() => agentFileLockAcquire.input.parse({ path: "a.ts", action: "delete" })).toThrow();
  });

  it("parses a granted output", () => {
    const parsed = agentFileLockAcquire.output.parse({
      granted: true,
      lockId: "lock-1",
      heldBy: null,
      blockedUntil: null,
    });
    expect(parsed.granted).toBe(true);
  });

  it("parses a denied output", () => {
    const parsed = agentFileLockAcquire.output.parse({
      granted: false,
      lockId: "",
      heldBy: "agent-b",
      blockedUntil: 1_700_000_000_000,
    });
    expect(parsed.granted).toBe(false);
    expect(parsed.heldBy).toBe("agent-b");
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.file.lock.acquire")).toBe(agentFileLockAcquire);
  });

  it("defaults to org Owner/Admin and workspace Owner/Member allow", () => {
    expect(agentFileLockAcquire.defaultRoles.org.Owner).toBe("allow");
    expect(agentFileLockAcquire.defaultRoles.org.Admin).toBe("allow");
    expect(agentFileLockAcquire.defaultRoles.workspace.Member).toBe("allow");
  });
});
