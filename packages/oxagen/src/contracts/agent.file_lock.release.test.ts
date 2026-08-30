import { describe, expect, it } from "vitest";
import { agentFileLockRelease } from "./agent.file_lock.release";
import { getCapability } from "../registry";

describe("agent.file.lock.release capability", () => {
  it("requires a lockId", () => {
    expect(() => agentFileLockRelease.input.parse({})).toThrow();
  });

  it("parses a valid input", () => {
    const parsed = agentFileLockRelease.input.parse({ lockId: "lock-1" });
    expect(parsed.lockId).toBe("lock-1");
  });

  it("parses a released:true output", () => {
    expect(agentFileLockRelease.output.parse({ released: true })).toEqual({
      released: true,
    });
  });

  it("parses a released:false output (idempotent, not an error)", () => {
    expect(agentFileLockRelease.output.parse({ released: false })).toEqual({
      released: false,
    });
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("release_file_lock")).toBe(agentFileLockRelease);
  });

  it("is gated to Owner/Admin ONLY — no Member default grant (force-release is an admin/debug action)", () => {
    expect(agentFileLockRelease.defaultRoles.org.Owner).toBe("allow");
    expect(agentFileLockRelease.defaultRoles.org.Admin).toBe("allow");
    // The workspace role map is intentionally typed as Owner-only, so index it
    // through a widened view to assert Member is genuinely absent (not granted).
    expect(
      (agentFileLockRelease.defaultRoles.workspace as Record<string, unknown>)
        .Member,
    ).toBeUndefined();
  });
});
