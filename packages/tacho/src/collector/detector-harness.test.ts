/**
 * The detector on a host that does not hook Claude Code. A Codex-only host
 * has no Claude Code hooks to lose, so their absence is not an incident.
 */
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import { TEST_ENROLLMENT } from "../host/test-support";
import { Detector } from "./detector";
import { SessionRegistry } from "./registry";

const CONTEXT: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cc-laptop",
    fleet_id: "wrk_1",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
    host_enrollment_id: TEST_ENROLLMENT,
  },
};

function detector(claudeCodeEnrolled?: () => boolean): Detector {
  const now = () => 1_790_000_000_000;
  const registry = new SessionRegistry({
    context: CONTEXT,
    scope: TEST_ENROLLMENT,
    now,
  });
  const host = registry.ensure("tachod-boot", { pid: process.pid }).record;
  return new Detector({
    registry,
    hostRecorder: () => host.recorder,
    listProcesses: () => [],
    transcriptRoots: [],
    readSettings: () => ({}),
    enrollmentId: TEST_ENROLLMENT,
    ...(claudeCodeEnrolled !== undefined ? { claudeCodeEnrolled } : {}),
    now,
  });
}

describe("the hook-removal detector", () => {
  it("reports missing Claude Code hooks on a host that hooks Claude Code", async () => {
    expect((await detector().tick()).map((e) => e.kind)).toEqual([
      "oxagen:hooks_removed",
    ]);
    expect((await detector(() => true).tick()).map((e) => e.kind)).toEqual([
      "oxagen:hooks_removed",
    ]);
  });

  it("says nothing on a host that never hooked Claude Code, and notices when that changes", async () => {
    let enrolled = false;
    const d = detector(() => enrolled);
    expect(await d.tick()).toEqual([]);
    expect(d.hooksHealthy).toBeUndefined();
    expect(d.presence).toBeUndefined();
    enrolled = true;
    expect((await d.tick()).map((e) => e.kind)).toEqual([
      "oxagen:hooks_removed",
    ]);
  });
});
