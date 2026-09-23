/**
 * An out-of-bounds absorbed context or host fact.
 *
 * `absorbContext`/`absorbHost` write git facts, hook-reported context, and
 * ambient host facts straight onto the recorder's sticky `context`/`host`
 * before the frame that carries the update is ever sealed. A field past its
 * envelope bound used to merge in unclipped: `seal()` validates the whole
 * envelope on every call, so the very next seal threw, `rollbackChain`
 * leaves absorbed facts as observed by design (they are not a chain
 * position), and a restart copied the poisoned value straight back in. One
 * long git branch name silenced the session for good. This file proves a
 * value over the bound clips instead, on the way in and on restore.
 */
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { TachoEvent } from "../envelope";
import type { ClaudeCodeContext } from "./context";
import { type RecorderState, SessionRecorder } from "./recorder";

const ID = "33333333-4444-5555-6666-777777777777";
const SCOPE = "host-absorbed-bounds-test";
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

function started(scope: string): SessionRecorder {
  const chain = new SessionRecorder({ context, harnessSessionId: ID, scope });
  chain.ingestHook({ session_id: ID, hook_event_name: "SessionStart" }, {}, at);
  return chain;
}

describe("absorbed context and host facts", () => {
  it("clips a git fact over the envelope's bound rather than poisoning every later seal", () => {
    const chain = started(`${SCOPE}-git`);
    // `context.git_branch` is bounded at 512 bytes; a collector-observed
    // branch name (`noteContext`, the same path the daemon's git lane uses)
    // past that bound must not survive into the sticky context unclipped.
    chain.noteContext({ git_branch: "x".repeat(600) });
    expect(() =>
      chain.sealCollectorEvent("oxagen:notification", {}, { ts: at }),
    ).not.toThrow();
    const event = chain.sealedEvents.at(-1) as TachoEvent;
    expect(event.context?.git_branch?.length).toBeLessThanOrEqual(512);
    // Every seal after the oversized fact still succeeds; the sticky state
    // healed rather than staying poisoned.
    expect(() =>
      chain.sealCollectorEvent("oxagen:notification", {}, { ts: at }),
    ).not.toThrow();
    expect(verifyChain([...chain.sealedEvents]).ok).toBe(true);
  });

  it("clips an oversized cwd a hook reported", () => {
    const chain = started(`${SCOPE}-cwd`);
    // `context.cwd` is bounded at 4096 bytes.
    const [event] = chain.ingestHook(
      {
        session_id: ID,
        hook_event_name: "UserPromptSubmit",
        prompt: "go",
        cwd: "/".repeat(5000),
      },
      {},
      at,
    );
    expect(event?.context?.cwd?.length).toBeLessThanOrEqual(4096);
    expect(verifyChain([...chain.sealedEvents]).ok).toBe(true);
  });

  it("clamps a poisoned context a pre-fix build already persisted", () => {
    const chain = started(`${SCOPE}-restore`);
    const state = chain.state();
    const poisoned: RecorderState = {
      ...state,
      context: {
        ...state.context,
        permission_mode: "y".repeat(9000),
      } as RecorderState["context"],
      host: {
        ...state.host,
        os_type: "z".repeat(9000),
      } as RecorderState["host"],
    };
    const restored = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: `${SCOPE}-restore`,
      restore: poisoned,
    });
    const [event] = restored.ingestHook(
      { session_id: ID, hook_event_name: "UserPromptSubmit", prompt: "go" },
      {},
      at,
    );
    expect(event?.context?.permission_mode?.length).toBeLessThanOrEqual(512);
    expect(event?.host?.os_type?.length).toBeLessThanOrEqual(512);
    // The restored recorder continues the same chain, so the events before
    // and after the restart verify together, from genesis.
    expect(
      verifyChain([...chain.sealedEvents, ...restored.sealedEvents], {
        expectGenesis: true,
      }).ok,
    ).toBe(true);
  });
});
