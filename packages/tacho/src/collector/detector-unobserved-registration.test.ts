/**
 * An unobserved session — a transcript advancing with no hook stream — used
 * to seal exactly one incident frame and record nothing else: the detector
 * never registered it, and the transcript tailer only walks sessions the
 * registry already knows. The detector now registers an ambient session
 * (harness unclaimed, transcript path set) at the moment it seals the
 * incident, so the tailer picks it up from byte 0 on its next tick.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

describe("the unobserved-session detector", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  it("registers an ambient session with the transcript path when it seals the incident", async () => {
    const root = mkdtempSync(join(tmpdir(), "tacho-unobserved-"));
    dirs.push(root);
    const project = join(root, "-repo");
    mkdirSync(project, { recursive: true });
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const path = join(project, `${sessionId}.jsonl`);
    writeFileSync(path, "{}\n");

    let clock = 1_790_000_000_000;
    const now = () => clock;
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now,
    });
    const host = registry.ensure("tachod-boot", { pid: process.pid }).record;
    const d = new Detector({
      registry,
      hostRecorder: () => host.recorder,
      listProcesses: () => [],
      transcriptRoots: [root],
      readSettings: () => ({}),
      enrollment: () => ({
        enrollmentId: TEST_ENROLLMENT,
        harnesses: [],
        verified: true,
      }),
      graceMs: 5_000,
      now,
    });

    const stamp = (at: number) => utimesSync(path, new Date(at), new Date(at));
    stamp(clock);
    await d.tick(); // first sighting
    // Before the grace period elapses, the session is not registered yet.
    expect(registry.get(sessionId)).toBeUndefined();

    clock += 6_000;
    stamp(clock);
    const incidents = await d.tick();
    expect(incidents.map((e) => e.kind)).toEqual(["oxagen:unobserved_session"]);
    // The incident still seals; a registry session now exists to carry the
    // transcript to the tailer.
    const registered = registry.get(sessionId);
    expect(registered).toBeDefined();
    expect(registered?.ambient).toBe(true);
    expect(registered?.transcriptPath).toBe(path);
    expect(registered?.harness).toBeUndefined();

    // The very next tick treats it as a known session and stops tracking it
    // as a sighting, the same path a hooked session already takes.
    clock += 1_000;
    stamp(clock);
    expect(await d.tick()).toEqual([]);
    expect(d.unobserved).toEqual([]);
  });
});
