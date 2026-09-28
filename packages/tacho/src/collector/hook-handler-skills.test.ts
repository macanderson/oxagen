/**
 * The hook path places a session's published skills at a live start and
 * removes them at its end (#4458). Only a verified bundle places any, and a
 * blocked or replayed start, or a custom agent, places none.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import { encodeSkill } from "../skills";
import type { BundleSkill, PolicyBundle, TachoHarness } from "../wire";
import { handleHookEvent, type PolicyView } from "./hook-handler";
import { SessionRegistry } from "./registry";
import type { SessionSkills } from "./session-skills";

const FIXTURES = join(__dirname, "..", "..", "fixtures", "claude-code", "hooks");

const fixture = (name: string): Record<string, unknown> =>
  (
    JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as {
      stdin: Record<string, unknown>;
    }
  ).stdin;

const START = fixture("01-SessionStart.json");
const END = fixture("24-SessionEnd.json");
const SESSION = START["session_id"] as string;

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

const SKILLS: BundleSkill[] = [
  encodeSkill({
    lineage: "a-intel.brand.voice",
    name: "a-intel-brand-voice",
    description: "Write in the a-intel voice.",
    body: "# Brand voice\n",
    files: [{ path: "words.md", content: "# Words\n" }],
    source: "workspace",
    version: 21,
  }),
];

const ENV = { CLAUDE_CONFIG_DIR: "/work/.claude-alt" };

interface Call {
  op: "place" | "remove";
  harness: TachoHarness;
  sessionId: string;
  skills?: readonly BundleSkill[];
  env?: Readonly<Record<string, string | undefined>>;
}

function daemon(
  bundleOverrides: Partial<Omit<PolicyBundle, "signature">> = { skills: SKILLS },
  viewOverrides: Partial<PolicyView> = {},
) {
  const bundle = bundleSigner().sign(unsignedBundle(bundleOverrides));
  let clock = Date.parse("2026-09-27T01:00:00.000Z");
  const now = () => (clock += 1000);
  const registry = new SessionRegistry({ context: CONTEXT, scope: TEST_ENROLLMENT, now });
  const view: PolicyView = {
    bundle,
    verified: true,
    hostStatus: "active",
    denyGeneration: bundle.deny_generation,
    controlReachable: true,
    ...viewOverrides,
  };
  const calls: Call[] = [];
  const skills: SessionSkills = {
    place: async (harness, sessionId, placed, env) => {
      calls.push({ op: "place", harness, sessionId, skills: placed, env });
    },
    remove: async (harness, sessionId, env) => {
      calls.push({ op: "remove", harness, sessionId, env });
    },
  };
  const deps = { registry, policy: () => view, acknowledge: () => undefined, now, skills };
  return { deps, calls };
}

describe("handleHookEvent with published skills", () => {
  it("places a verified bundle's skills at a live start, in the harness's env", async () => {
    const { deps, calls } = daemon();
    await handleHookEvent(START, ENV, deps);
    expect(calls).toEqual([
      { op: "place", harness: "claude-code", sessionId: SESSION, skills: SKILLS, env: ENV },
    ]);
  });

  it("removes the session's skills at SessionEnd", async () => {
    const { deps, calls } = daemon();
    await handleHookEvent(START, ENV, deps);
    await handleHookEvent(END, ENV, deps);
    expect(calls.at(-1)).toEqual({
      op: "remove",
      harness: "claude-code",
      sessionId: SESSION,
      env: ENV,
    });
  });

  it("removes at SessionEnd even when the end is replayed", async () => {
    const { deps, calls } = daemon();
    await handleHookEvent(START, ENV, deps);
    await handleHookEvent(END, ENV, deps, { receivedAt: "2026-09-27T01:00:05.000Z" });
    expect(calls.map((call) => call.op)).toEqual(["place", "remove"]);
  });

  it("places nothing at a replayed start, which reaches a session already running", async () => {
    const { deps, calls } = daemon();
    await handleHookEvent(START, ENV, deps, { receivedAt: "2026-09-27T01:00:00.500Z" });
    expect(calls).toEqual([]);
  });

  it("places nothing from a bundle whose signature the host did not verify", async () => {
    const { deps, calls } = daemon({ skills: SKILLS }, { verified: false });
    await handleHookEvent(START, ENV, deps);
    expect(calls).toEqual([]);
  });

  it("places nothing at a start the operator blocked", async () => {
    const { deps, calls } = daemon({ skills: SKILLS }, { hostStatus: "paused" });
    const outcome = await handleHookEvent(START, ENV, deps);
    expect(outcome.response).toMatchObject({ continue: false });
    expect(calls).toEqual([]);
  });

  it("places nothing when the bundle carries no skills", async () => {
    const { deps, calls } = daemon({});
    await handleHookEvent(START, ENV, deps);
    expect(calls).toEqual([]);
  });

  it("places and removes nothing for a custom agent, which reads no harness's folder", async () => {
    const { deps, calls } = daemon();
    await handleHookEvent(START, ENV, deps, undefined, undefined, "docs-bot");
    await handleHookEvent(END, ENV, deps, undefined, undefined, "docs-bot");
    expect(calls).toEqual([]);
  });
});
