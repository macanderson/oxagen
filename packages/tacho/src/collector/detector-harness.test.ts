/**
 * The detector on a host that does not hook Claude Code. A Codex-only host
 * has no Claude Code hooks to lose, so their absence is not an incident.
 */
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import { TEST_ENROLLMENT } from "../host/test-support";
import { mergeTachoSettings } from "../host/settings-writer";
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

function detector(opts?: {
  harnesses?: () => string[];
  enrollmentId?: () => string;
  readSettings?: () => unknown;
}): Detector {
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
    readSettings: opts?.readSettings ?? (() => ({})),
    enrollment: () => ({
      enrollmentId: opts?.enrollmentId?.() ?? TEST_ENROLLMENT,
      harnesses: opts?.harnesses?.() ?? ["claude-code"],
    }),
    now,
  });
}

describe("the hook-removal detector", () => {
  it("reports missing Claude Code hooks on a host that hooks Claude Code", async () => {
    expect((await detector().tick()).map((e) => e.kind)).toEqual([
      "oxagen:hooks_removed",
    ]);
    expect(
      (await detector({ harnesses: () => ["claude-code"] }).tick()).map(
        (e) => e.kind,
      ),
    ).toEqual(["oxagen:hooks_removed"]);
  });

  it("records hook seals before the transcript scan awaits", async () => {
    const d = detector();
    const host = (
      d as unknown as {
        deps: { hostRecorder: () => { chainCursor: { seq: number } } };
      }
    ).deps.hostRecorder();
    const before = host.chainCursor.seq;
    const recordedLengths: number[] = [];
    // Hooks are sealed and handed to `record` before the scan yields, so they
    // reach the WAL ahead of any model or gateway call sealed during the wait.
    const pass = d.tick((events) => {
      recordedLengths.push(events.length);
    });
    expect(host.chainCursor.seq).toBe(before + 1);
    expect(recordedLengths).toEqual([1]);
    expect((await pass).map((e) => e.kind)).toEqual(["oxagen:hooks_removed"]);
  });

  it("says nothing on a host that never hooked Claude Code, and notices when that changes", async () => {
    let harnesses: string[] = [];
    const d = detector({ harnesses: () => harnesses });
    expect(await d.tick()).toEqual([]);
    expect(d.hooksHealthy).toBeUndefined();
    expect(d.presence).toBeUndefined();
    harnesses = ["claude-code"];
    expect((await d.tick()).map((e) => e.kind)).toEqual([
      "oxagen:hooks_removed",
    ]);
  });

  it("checks hooks against a live reassign's enrollment id, not the one it started with (#3398)", async () => {
    // The regression this guards: `enrollmentId` used to be a value fixed at
    // Detector construction, so a `reassign` that swapped both the harness
    // list and the enrollment id under a running daemon left the hook
    // presence check comparing the new settings against the old id forever,
    // chaining a false `oxagen:hooks_removed` incident until restart.
    const OLD_ENROLLMENT = TEST_ENROLLMENT;
    const NEW_ENROLLMENT = "enr_reassigned";
    // Settings on disk carry the *original* enrollment's hooks and env.
    const oldSettings = mergeTachoSettings(
      {},
      {
        enrollmentId: OLD_ENROLLMENT,
        hookCommand: "x",
        port: 1,
        localToken: "t",
      },
    ).settings;
    // `reassign` rewrites host.json and the settings file together: after
    // it lands, settings on disk carry the *new* enrollment's hooks and env.
    const newSettings = mergeTachoSettings(
      {},
      {
        enrollmentId: NEW_ENROLLMENT,
        hookCommand: "x",
        port: 1,
        localToken: "t",
      },
    ).settings;
    let enrollmentId = OLD_ENROLLMENT;
    let settings: unknown = oldSettings;
    const d = detector({
      harnesses: () => ["claude-code"],
      enrollmentId: () => enrollmentId,
      readSettings: () => settings,
    });
    // Before the reassign, the live enrollment id matches the settings on
    // disk (both are the daemon's original enrollment), so hooks are present.
    expect(await d.tick()).toEqual([]);
    expect(d.hooksHealthy).toBe(true);
    // `reassign` lands: host.json now names the new enrollment id, and the
    // settings file it rewrote alongside it now carries that new id's hooks.
    // If the detector still held the old id fixed at construction, this
    // tick would find no hooks for that stale id in the new settings and
    // wrongly chain `oxagen:hooks_removed`.
    enrollmentId = NEW_ENROLLMENT;
    settings = newSettings;
    expect(await d.tick()).toEqual([]);
    expect(d.hooksHealthy).toBe(true);
  });
});
