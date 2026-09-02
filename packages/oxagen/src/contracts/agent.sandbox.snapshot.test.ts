import { describe, expect, it } from "vitest";
import { agentSandboxSnapshot } from "./agent.sandbox.snapshot";
import { getCapability } from "../registry";

describe("agent.sandbox.snapshot capability", () => {
  it("is registered and scoped", () => {
    const cap = getCapability("snapshot_sandbox");
    expect(cap?.domain).toBe("agent");
    expect(cap?.scoped).toBe(true);
  });

  it("requires a sessionId", () => {
    expect(() => agentSandboxSnapshot.input.parse({})).toThrow();
    expect(
      agentSandboxSnapshot.input.parse({ sessionId: "sbx_1" }).sessionId,
    ).toBe("sbx_1");
  });

  it("validates the output shape", () => {
    const out = agentSandboxSnapshot.output.parse({ snapshotId: "im-123" });
    expect(out.snapshotId).toBe("im-123");
  });
});
