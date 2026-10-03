/**
 * The reflection ask at a Stop (`memory-capture/reflection-ask.ts`), through
 * the hook handler: the hooks that count as signs of trouble, and the one
 * Stop a Claude Code session is blocked at to record a reflection.
 */
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import type { CommandAcknowledgement, TachoHarness } from "../wire";
import { handleHookEvent, type PolicyView } from "./hook-handler";
import {
  REFLECTION_TOOL_NAME,
  reflectionAsk,
} from "./memory-capture/reflection-ask";
import { type QueuedPrompt, SessionRegistry } from "./registry";

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

const SESSION = "5b0c1d7e-2f43-4a8e-9c61-0d2b7f3e8a14";

/**
 * A host's hook handler. `toolRegistered` answers whether the enrollment
 * gave Claude Code Oxagen's MCP server (#5287); `null` leaves the port out,
 * as a handler with no daemon behind it has. (`undefined` would take the
 * default.)
 */
function harness(
  toolRegistered:
    | ((session: { startedAt: string; cwd?: string }) => boolean)
    | null = () => true,
) {
  const bundle = bundleSigner().sign(unsignedBundle());
  let clock = Date.parse("2026-09-10T10:00:00.000Z");
  const now = () => (clock += 1000);
  const registry = new SessionRegistry({
    context: CONTEXT,
    scope: TEST_ENROLLMENT,
    now,
  });
  const view: PolicyView = {
    bundle,
    verified: true,
    hostStatus: "active",
    denyGeneration: bundle.deny_generation,
    controlReachable: true,
  };
  const acks: CommandAcknowledgement[] = [];
  const deps = {
    registry,
    policy: () => view,
    acknowledge: (ack: CommandAcknowledgement) => acks.push(ack),
    now,
    ...(toolRegistered !== null
      ? { reflectionToolRegistered: toolRegistered }
      : {}),
  };
  return { registry, deps, acks };
}

type Harness = ReturnType<typeof harness>;

function hook(
  hook_event_name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: SESSION,
    cwd: "/home/dev/proj",
    hook_event_name,
    ...extra,
  };
}

const READ = {
  tool_name: "Read",
  tool_input: { file_path: "/home/dev/proj/README.md" },
  tool_use_id: "toolu_read",
};

/** Sends one hook, as Claude Code unless another harness is named. */
function send(
  h: Harness,
  payload: Record<string, unknown>,
  agentHarness?: TachoHarness,
) {
  return handleHookEvent(payload, {}, h.deps, undefined, agentHarness);
}

/** A read the agent makes and sees fail. */
async function failRead(h: Harness, agentHarness?: TachoHarness) {
  await send(h, hook("PreToolUse", READ), agentHarness);
  await send(
    h,
    hook("PostToolUseFailure", { ...READ, error: "ENOENT" }),
    agentHarness,
  );
}

/** A session that starts, reads a file and sees the read fail. */
async function failedRead(h: Harness, agentHarness?: TachoHarness) {
  await send(h, hook("SessionStart", { source: "startup" }), agentHarness);
  await failRead(h, agentHarness);
}

const ASKED_FOR_A_FAILED_READ = expect.stringMatching(
  /^This run had a failed tool call \(Read\)\. Before you finish, call mcp__oxagen__record_reflection once to record a reflection\./,
);

describe("a Claude Code Stop", () => {
  it("is blocked with the ask after a failed tool call", async () => {
    const h = harness();
    await failedRead(h);
    const stop = await send(h, hook("Stop", { stop_hook_active: false }));
    expect(stop.response).toEqual({
      decision: "block",
      reason: ASKED_FOR_A_FAILED_READ,
    });
    const reason = stop.response["reason"] as string;
    expect(reason).toContain(`call ${REFLECTION_TOOL_NAME} once`);
    expect(reason).toContain(
      "Skip the call only if the tool is not available.",
    );
  });

  it("is not blocked again when it follows the block, or at a later Stop", async () => {
    const h = harness();
    await failedRead(h);
    const first = await send(h, hook("Stop", { stop_hook_active: false }));
    expect(first.response["decision"]).toBe("block");
    // The agent records the reflection, and Claude Code says the Stop
    // follows a block.
    await send(
      h,
      hook("PreToolUse", {
        tool_name: REFLECTION_TOOL_NAME,
        tool_input: { outcome: "The README path was wrong." },
        tool_use_id: "toolu_reflect",
      }),
    );
    const second = await send(h, hook("Stop", { stop_hook_active: true }));
    expect(second.response).toEqual({});
    // A new failure in the next turn is not asked about: one ask a session.
    await send(h, hook("UserPromptSubmit", { prompt: "Try the docs path." }));
    await failRead(h);
    const third = await send(h, hook("Stop", { stop_hook_active: false }));
    expect(third.response).toEqual({});
  });

  it("is not blocked when the run showed no trouble", async () => {
    const h = harness();
    await send(h, hook("SessionStart", { source: "startup" }));
    await send(h, hook("UserPromptSubmit", { prompt: "Add a README." }));
    await send(h, hook("PreToolUse", READ));
    await send(h, hook("PostToolUse", { ...READ, tool_response: "ok" }));
    const stop = await send(h, hook("Stop", { stop_hook_active: false }));
    expect(stop.response).toEqual({});
  });

  it("is blocked after a call the policy denied", async () => {
    const h = harness();
    await send(h, hook("SessionStart", { source: "startup" }));
    const push = await send(
      h,
      hook("PreToolUse", {
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
        tool_use_id: "toolu_push",
      }),
    );
    expect(push.evaluation).toMatchObject({ decision: "deny" });
    expect(push.evaluation?.source).not.toBe("human");
    const stop = await send(h, hook("Stop"));
    expect(stop.response).toEqual({
      decision: "block",
      reason: expect.stringMatching(
        /^This run had a call the policy denied \(Bash\)\./,
      ),
    });
  });

  it("is blocked after the same call three times in a row", async () => {
    const h = harness();
    await send(h, hook("SessionStart", { source: "startup" }));
    for (let call = 0; call < 3; call += 1)
      await send(h, hook("PreToolUse", { ...READ, tool_use_id: `t${call}` }));
    const stop = await send(h, hook("Stop"));
    expect(stop.response["reason"]).toMatch(
      /^This run had a call repeated 3 times in a row \(Read\)\./,
    );
  });

  it("is blocked after a prompt that corrected the agent", async () => {
    const h = harness();
    await send(h, hook("SessionStart", { source: "startup" }));
    await send(h, hook("UserPromptSubmit", { prompt: "Add a README." }));
    await send(
      h,
      hook("UserPromptSubmit", { prompt: "No, put it in docs/ instead." }),
    );
    const stop = await send(h, hook("Stop"));
    expect(stop.response["reason"]).toMatch(
      /^This run had a prompt that corrected you\./,
    );
  });

  it("carries a queued steer first and the ask after it", async () => {
    const h = harness();
    await failedRead(h);
    const record = h.registry.get(SESSION);
    if (record === undefined) throw new Error("no record");
    const steer: QueuedPrompt = {
      id: "cmd_s",
      text: "Also update the changelog.",
      command: "steer",
      requestedMode: "next_step",
      deliveryMode: "next_step",
      degradedReason: null,
      expiresAt: null,
    };
    record.control.messages.push(steer);
    const stop = await send(h, hook("Stop"));
    const reason = stop.response["reason"] as string;
    const [first, ...rest] = reason.split("\n\n");
    expect(first).toBe("Also update the changelog.");
    expect(rest.join("\n\n")).toEqual(ASKED_FOR_A_FAILED_READ);
    expect(h.acks.map((ack) => [ack.command_id, ack.status])).toEqual([
      ["cmd_s", "applied"],
    ]);
  });

  it("leaves the ask for a live Stop when it is replayed or a subagent's", async () => {
    const h = harness();
    await failedRead(h);
    const replayed = await handleHookEvent(hook("Stop"), {}, h.deps, {
      receivedAt: "2026-09-10T09:59:00.000Z",
    });
    expect(replayed.response).toEqual({});
    const subagent = await send(
      h,
      hook("Stop", { agent_id: "agent-1", agent_type: "Explore" }),
    );
    expect(subagent.response).toEqual({});
    const stop = await send(h, hook("Stop"));
    expect(stop.response["reason"]).toEqual(ASKED_FOR_A_FAILED_READ);
  });
});

describe("a Stop the ask does not reach", () => {
  it("does not block a Codex session", async () => {
    const h = harness();
    await failedRead(h, "codex");
    const stop = await send(
      h,
      hook("Stop", { stop_hook_active: false }),
      "codex",
    );
    expect(stop.response).toEqual({});
    // The failure counted; the harness is what the ask refused.
    const record = stop.record;
    if (record === undefined) throw new Error("no record");
    expect(record.harness).toBe("codex");
    expect(
      reflectionAsk(record, {
        harness: "claude-code",
        stopHookActive: false,
        replayed: false,
        toolRegistered: () => true,
      }),
    ).toEqual(ASKED_FOR_A_FAILED_READ);
  });

  it("does not block a session whose host gave Claude Code no Oxagen MCP server (#5287)", async () => {
    let checks = 0;
    const h = harness(() => {
      checks += 1;
      return false;
    });
    await failedRead(h);
    const stop = await send(h, hook("Stop", { stop_hook_active: false }));
    expect(stop.response).toEqual({});
    expect(checks).toBe(1);
    // The failure counted, and the ask is still owed: only the missing tool
    // held it back.
    const record = stop.record;
    if (record === undefined) throw new Error("no record");
    expect(
      reflectionAsk(record, {
        harness: "claude-code",
        stopHookActive: false,
        replayed: false,
        toolRegistered: () => true,
      }),
    ).toEqual(ASKED_FOR_A_FAILED_READ);
  });

  it("checks for the tool in the session's own directory (#5390)", async () => {
    // A local- or project-scope `oxagen` server there wins over ours. Asked
    // without the directory, the check read only the user scope.
    const checked: Array<string | undefined> = [];
    const h = harness((session) => {
      checked.push(session.cwd);
      return false;
    });
    await failedRead(h);
    const stop = await send(h, hook("Stop", { stop_hook_active: false }));
    expect(checked).toEqual(["/home/dev/proj"]);
    expect(stop.response).toEqual({});
  });

  it("does not block a session when the handler cannot tell whether the tool is there", async () => {
    const h = harness(null);
    await failedRead(h);
    const stop = await send(h, hook("Stop", { stop_hook_active: false }));
    expect(stop.response).toEqual({});
  });

  it("does not block a custom agent, which may have no Oxagen MCP server", async () => {
    const h = harness();
    const custom = (payload: Record<string, unknown>) =>
      handleHookEvent(payload, {}, h.deps, undefined, undefined, "reviewer");
    await custom(hook("SessionStart", { source: "startup" }));
    await custom(hook("PreToolUse", READ));
    await custom(hook("PostToolUseFailure", { ...READ, error: "ENOENT" }));
    const stop = await custom(hook("Stop"));
    expect(stop.response).toEqual({});
    expect(stop.record?.customAgent).toBe("reviewer");
  });
});
