/**
 * The registry's bound on a tool name and the run spec's bound on a tool
 * identity are one decision, written in two packages that cannot import each
 * other (`@oxagen/oxagen` does not depend on `@oxagen/run-ledger`, and the
 * kernel should not start). `@oxagen/agent` depends on both, so this is where
 * they can be held equal.
 *
 * Why it is worth a file of its own: an MCP tool is governed under the
 * synthetic identity `mcp.<server uuid>.<name>`, and `openAssistantRun` pins
 * EVERY materialized tool into the run spec's tool policy. A name the
 * registry accepts and the spec refuses therefore does not fail that tool —
 * it fails spec admission for every assistant turn in the workspace,
 * including turns that never mention the tool. The failure is total, and it
 * is nowhere near either bound.
 *
 * The original defect was exactly this drift: the external form inherited the
 * single-segment `.max(128)` from the platform-capability form, while the
 * identity it validates spends 41 of those on `mcp.` plus a 36-character
 * UUID. That made the real, undocumented limit 87.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { EXTERNAL_TOOL_SEGMENT_MAX, parseRunSpecV2 } from "@oxagen/run-ledger";
import { TOOL_NAME_MAX_LENGTH } from "@oxagen/oxagen/contracts/tool.declaration.publish";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

/** A minimal admissible spec whose only variable is the tool allowlist. */
function specWith(allowlist: string[]) {
  return {
    version: 2,
    run_kind: "general",
    goal: "g",
    engine_policy: {
      requested_engine: "stella",
      allowed_engine_versions: ["1.0.0"],
      model_policy_ref: "assistant.funding_source",
      max_steps: 4,
      max_attempts: 1,
    },
    actor_binding: {
      initiating_principal_id: UUID,
      agent_principal_id: UUID,
      agent_id: UUID,
      agent_version_id: UUID,
      agent_version_checksum: `sha256:${"a".repeat(64)}`,
    },
    authorization_snapshot_ref: {
      snapshot_id: UUID,
      snapshot_digest: `sha256:${"b".repeat(64)}`,
      grant_ceiling_digest: `sha256:${"c".repeat(64)}`,
      deny_generation_at_admission: { org: "1", workspace: "1" },
      resolved_at: "2026-01-01T00:00:00.000Z",
    },
    workspace_policy: { sandbox_required: false },
    context_policy: {
      provider_allowlist: ["engram"],
      max_frames: 1,
      max_tokens: 100,
      retention_policy_id: "rpol_0123456789abcdef0123",
      retention_policy_digest: `sha256:${"d".repeat(64)}`,
    },
    tool_policy: { allowlist, risk_ceiling: "high" },
  };
}

describe("registry tool names fit the run spec's tool identities", () => {
  it("admits the longest name the registry accepts, under an MCP server UUID", () => {
    // The exact shape `registryCapabilityId` builds, at the registry's limit.
    const name = `a${"b".repeat(TOOL_NAME_MAX_LENGTH - 1)}`;
    expect(name).toHaveLength(TOOL_NAME_MAX_LENGTH);
    const identity = `mcp.${randomUUID()}.${name}`;
    // Not asserted as a constant: this is the number the old flat bound got
    // wrong, so it is computed from the parts and read here.
    expect(identity.length).toBeGreaterThan(128);

    expect(() => parseRunSpecV2(specWith([identity]))).not.toThrow();
  });

  it("admits it under the longer `file-mcp` prefix and a full-length server segment", () => {
    // The worst case the bound has to cover: longest prefix, longest server
    // segment, longest tool segment.
    const server = `s${"e".repeat(EXTERNAL_TOOL_SEGMENT_MAX - 1)}`;
    const name = `t${"f".repeat(TOOL_NAME_MAX_LENGTH - 1)}`;
    expect(() =>
      parseRunSpecV2(specWith([`file-mcp.${server}.${name}`])),
    ).not.toThrow();
  });

  it("keeps the registry's bound at or under the spec's segment bound", () => {
    // The invariant, stated once. If the registry ever accepts a longer name
    // than a segment holds, the two tests above stop being reachable and the
    // workspace-wide failure comes back.
    expect(TOOL_NAME_MAX_LENGTH).toBeLessThanOrEqual(EXTERNAL_TOOL_SEGMENT_MAX);
  });

  it("still refuses a segment past the bound rather than accepting any string", () => {
    // The separation this form exists for: widening it must not have turned
    // the allowlist into "any string".
    const tooLong = `mcp.${randomUUID()}.${"z".repeat(EXTERNAL_TOOL_SEGMENT_MAX + 1)}`;
    expect(() => parseRunSpecV2(specWith([tooLong]))).toThrow();
    // And a platform capability is still held to its own, closed form.
    expect(() => parseRunSpecV2(specWith(["Not-A-Capability"]))).toThrow();
  });
});
