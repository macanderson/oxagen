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
  verified?: () => boolean;
  readSettings?: () => unknown;
  log?: (line: string) => void;
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
      verified: opts?.verified?.() ?? true,
    }),
    ...(opts?.log !== undefined ? { log: opts.log } : {}),
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

  it("keeps checking against the last verified enrollment, and still chains hooks_removed, when host.json goes unreadable (#3398)", async () => {
    // The regression this guards: disabling the check while host.json is
    // unreadable handed an attacker the exact evasion this control exists
    // to close -- make the enrollment file unreadable, then strip the
    // hooks, and nothing chains (docs/specs/tacho/spec.md section 11's
    // threat-model table, and section 14 acceptance item 8). A tamper
    // detector must not go quiet when its own configuration becomes
    // unreadable; that is precisely when it must keep working.
    const logged: string[] = [];
    let verified = true;
    // The "live" enrollment id the caller's read would report right now.
    // While unverified this deliberately differs from the daemon's
    // last-confirmed id, so a test failure here would mean the check
    // trusted an unverified live read instead of the remembered one.
    let liveEnrollmentId = TEST_ENROLLMENT;
    const completeSettings = mergeTachoSettings(
      {},
      {
        enrollmentId: TEST_ENROLLMENT,
        hookCommand: "x",
        port: 1,
        localToken: "t",
      },
    ).settings;
    let settings: unknown = completeSettings;
    const d = detector({
      harnesses: () => ["claude-code"],
      verified: () => verified,
      enrollmentId: () => liveEnrollmentId,
      readSettings: () => settings,
      log: (line) => logged.push(line),
    });
    // Establishes the last-verified pair: enrollment id TEST_ENROLLMENT,
    // hooks present and complete.
    expect(await d.tick()).toEqual([]);
    expect(d.hooksHealthy).toBe(true);
    // host.json becomes unreadable, and in the same window an attacker
    // strips the hooks from settings.json. The check must still fire.
    verified = false;
    liveEnrollmentId = "enr_should_be_ignored_while_unverified";
    settings = { hooks: {} };
    const removed = await d.tick();
    expect(removed.map((e) => e.kind)).toEqual(["oxagen:hooks_removed"]);
    expect(
      (
        removed[0]?.body as {
          incident_evidence: { enrollment_verified: boolean };
        }
      ).incident_evidence.enrollment_verified,
    ).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/enrollment/i);
    // Still unreadable: no further log line for the same transition, and
    // no further incident since hooks were already flagged as missing.
    expect(await d.tick()).toEqual([]);
    expect(logged).toHaveLength(1);
    // host.json can be read again and the hooks are restored: the check
    // resumes against the freshly confirmed identity and reports health,
    // logging the recovery transition once.
    verified = true;
    liveEnrollmentId = TEST_ENROLLMENT;
    settings = completeSettings;
    expect((await d.tick()).map((e) => e.kind)).toEqual(["oxagen:hook_health"]);
    expect(logged).toHaveLength(2);
  });
});
