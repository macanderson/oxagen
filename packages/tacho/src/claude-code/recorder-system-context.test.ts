/**
 * The token sources and the system context on the recorder's model-call
 * frames (#4493), sealed through `sealCollectorEvent` the way the loopback
 * proxy seals them: which members a proxied call carries, where its steering
 * comes from, when a turn lists its parts, and what a rollback or a restart
 * keeps.
 */
import { describe, expect, it } from "vitest";
import { jcs } from "../digest";
import type { TachoEvent } from "../envelope";
import { type DraftContent, jsonContent } from "../evidence/frame-body";
import type { ClaudeCodeContext } from "./context";
import { SessionRecorder } from "./recorder";

const ID = "4493aaaa-2222-3333-4444-555555555555";
const SCOPE = "host-system-context-test";
const at = "2026-09-26T00:00:00.000Z";
const context: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.claude-code",
    fleet_id: "wrk_test",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
  },
};

const REQUEST = JSON.stringify({
  model: "claude-opus-4-5",
  max_tokens: 1024,
  system: "You are Claude Code, Anthropic's official CLI for Claude.",
  tools: [
    {
      name: "Read",
      description: "Read a file from the local filesystem.",
      input_schema: { type: "object" },
    },
    {
      name: "mcp__oxagen__search",
      description: "Search the workspace graph.",
      input_schema: { type: "object" },
    },
  ],
  messages: [{ role: "user", content: "What does recorder.ts do?" }],
});

const MANIFEST = {
  items: [
    {
      id: "no-force-push",
      kind: "record",
      force: "must",
      recorded_at: "2026-09-20T00:00:00.000Z",
      tokens: 40,
      outcome: "included",
    },
    {
      id: "old-style-guide",
      kind: "record",
      force: "should",
      recorded_at: "2026-09-01T00:00:00.000Z",
      tokens: 900,
      outcome: "cut",
    },
  ],
  included: 1,
  cut: 1,
};

function exchange(): DraftContent {
  return jsonContent(jcs({ request: REQUEST, response: '{"type":"message"}' }));
}

function recorder(): SessionRecorder {
  const made = new SessionRecorder({
    context,
    harnessSessionId: ID,
    scope: SCOPE,
  });
  made.ingestHook({ session_id: ID, hook_event_name: "SessionStart" }, {}, at);
  return made;
}

function body(event: TachoEvent): Record<string, unknown> {
  return event.body as Record<string, unknown>;
}

/** One proxied model call with its exchange body. */
function call(
  chain: SessionRecorder,
  own: Record<string, unknown> = {},
): TachoEvent {
  return chain.sealCollectorEvent(
    "llm_call",
    { provider: "anthropic", model: "claude-opus-4-5", ...own },
    { fidelity: "proxy", content: exchange() },
  );
}

type Part = { kind: string; name: string; tokens: number };

function parts(event: TachoEvent): Part[] | undefined {
  return body(event)["system_context_parts"] as Part[] | undefined;
}

describe("a proxied model call's token sources", () => {
  it("carries the tool definition count and the system context digests", () => {
    const event = call(recorder());
    const fields = body(event);
    expect(fields["tool_definition_tokens"]).toEqual(expect.any(Number));
    expect(fields["tool_definition_tokens"]).toBeGreaterThan(0);
    expect(fields["tool_definition_tokens_basis"]).toBe("estimated");
    expect(fields["system_context_digest"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parts(event)?.map((part) => [part.kind, part.name])).toEqual([
      ["system", "system"],
      ["tool", "Read"],
      ["tool", "mcp__oxagen__search"],
    ]);
    // Claude Code's hook context rides the conversation (ADR-200), and no
    // manifest sealed, so neither source has a count.
    expect(fields).not.toHaveProperty("context_frame_tokens");
    expect(fields).not.toHaveProperty("steering_tokens");
  });

  it("takes the steering count from the session's steering manifest", () => {
    const chain = recorder();
    chain.sealCollectorEvent("steering.manifest", MANIFEST, {
      hook_event_name: "SessionStart",
    });
    const event = call(chain);
    expect(body(event)["steering_tokens"]).toBe(40);
    expect(body(event)["steering_tokens_basis"]).toBe("estimated");
    expect(parts(event)?.at(-1)).toMatchObject({
      kind: "steering",
      name: "no-force-push",
      tokens: 40,
    });
  });

  it("keeps a member the producer set itself", () => {
    const event = call(recorder(), {
      tool_definition_tokens: 7,
      tool_definition_tokens_basis: "reported",
    });
    expect(body(event)["tool_definition_tokens"]).toBe(7);
    expect(body(event)["tool_definition_tokens_basis"]).toBe("reported");
    expect(body(event)["system_context_digest"]).toMatch(/^sha256:/);
  });

  it("adds nothing to a call with no recorded request", () => {
    const event = recorder().sealCollectorEvent(
      "llm_call",
      { provider: "anthropic", model: "claude-opus-4-5" },
      { fidelity: "proxy" },
    );
    expect(body(event)).not.toHaveProperty("tool_definition_tokens");
    expect(body(event)).not.toHaveProperty("system_context_digest");
    expect(body(event)).not.toHaveProperty("system_context_parts");
  });
});

describe("when the recorder lists a call's system context", () => {
  it("lists the parts on the first call of a turn and the digest alone after", () => {
    const chain = recorder();
    const first = call(chain);
    const second = call(chain);
    expect(parts(first)).toHaveLength(3);
    expect(parts(second)).toBeUndefined();
    expect(body(second)["system_context_digest"]).toBe(
      body(first)["system_context_digest"],
    );
    chain.ingestHook(
      { session_id: ID, hook_event_name: "UserPromptSubmit", prompt: "go" },
      {},
      at,
    );
    expect(parts(call(chain))).toHaveLength(3);
  });

  it("lists again after a rollback undid the call that listed", () => {
    const chain = recorder();
    const mark = chain.markChain();
    expect(parts(call(chain))).toHaveLength(3);
    chain.rollbackChain(mark);
    expect(parts(call(chain))).toHaveLength(3);
  });

  it("carries the steering and the turn's listing over a restart", () => {
    const before = recorder();
    before.sealCollectorEvent("steering.manifest", MANIFEST, {
      hook_event_name: "SessionStart",
    });
    call(before);
    const state = before.state();
    expect(state.systemContext?.steering).toHaveLength(1);
    const after = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: SCOPE,
      restore: state,
    });
    const event = call(after);
    expect(parts(event)).toBeUndefined();
    expect(body(event)["steering_tokens"]).toBe(40);
  });

  it("writes no system context state before a call or a manifest", () => {
    expect(recorder().state()).not.toHaveProperty("systemContext");
  });
});
