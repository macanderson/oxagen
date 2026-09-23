/**
 * `trimSealedEvents`: a long-lived session's `events`/`metrics` arrays used
 * to grow for the whole daemon's lifetime — every sealed event and every
 * OTel metric point stayed in memory for as long as the process ran. This
 * proves the trim keeps the retained tail internally consistent (dense
 * seq, an unbroken hash chain) and that sealing continues normally after
 * it, on both a chain and its subagent.
 */
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { ClaudeCodeContext } from "./context";
import { SessionRecorder } from "./recorder";

const ID = "55555555-6666-7777-8888-999999999999";
const SCOPE = "host-trim-test";
const at = "2026-09-23T00:00:00.000Z";
const context: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.claude-code",
    fleet_id: "wrk_test",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
  },
};

describe("trimSealedEvents", () => {
  it("keeps only the most recent events, verifying without genesis", () => {
    const chain = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: SCOPE,
    });
    chain.ingestHook(
      { session_id: ID, hook_event_name: "SessionStart" },
      {},
      at,
    );
    for (let i = 0; i < 20; i += 1) {
      chain.sealCollectorEvent(
        "oxagen:notification",
        { notification_type: `n${i}` },
        { ts: at },
      );
    }
    expect(chain.sealedEvents).toHaveLength(21);
    chain.trimSealedEvents(5);
    expect(chain.sealedEvents).toHaveLength(5);
    // The retained tail is still an unbroken, densely-numbered chain; it
    // just no longer opens at genesis, which a caller who trimmed knows.
    const verification = verifyChain([...chain.sealedEvents], {
      expectGenesis: false,
    });
    expect(verification.ok).toBe(true);
    expect(chain.sealedEvents.at(-1)?.body).toMatchObject({
      notification_type: "n19",
    });
    // A full-history verification correctly reports the trimmed prefix
    // missing: trimming is opt-in exactly because this check regresses.
    expect(verifyChain([...chain.sealedEvents]).ok).toBe(false);
  });

  it("keeps sealing normally after a trim", () => {
    const chain = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: `${SCOPE}-seal`,
    });
    chain.ingestHook(
      { session_id: ID, hook_event_name: "SessionStart" },
      {},
      at,
    );
    for (let i = 0; i < 10; i += 1) {
      chain.sealCollectorEvent("oxagen:notification", {}, { ts: at });
    }
    chain.trimSealedEvents(3);
    const before = chain.chainCursor;
    const after = chain.sealCollectorEvent(
      "oxagen:notification",
      {},
      { ts: at },
    );
    expect(after.seq).toBe(before.seq);
    expect(chain.sealedEvents).toHaveLength(4);
    expect(
      verifyChain([...chain.sealedEvents], { expectGenesis: false }).ok,
    ).toBe(true);
  });

  it("trims a subagent chain along with its parent", () => {
    const chain = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: `${SCOPE}-sub`,
    });
    chain.ingestHook(
      { session_id: ID, hook_event_name: "SessionStart" },
      {},
      at,
    );
    chain.ingestHook(
      { session_id: ID, hook_event_name: "SubagentStart", agent_id: "child" },
      {},
      at,
    );
    const child = [...chain.openChildren.values()][0];
    if (child === undefined) throw new Error("no child recorder");
    for (let i = 0; i < 10; i += 1) {
      child.sealCollectorEvent("oxagen:notification", {}, { ts: at });
    }
    expect(child.sealedEvents.length).toBeGreaterThan(5);
    chain.trimSealedEvents(3);
    expect(child.sealedEvents).toHaveLength(3);
  });
});
