/**
 * A Claude Code tool call that ran is handed to `noteMemoryReads`, which
 * counts the memory files it read as uses in the call's run (ADR-245). The
 * run is the root session, so a subagent's read counts for the run it
 * belongs to. A failed call read nothing, and a session of another harness
 * reads no Claude Code memory as its own.
 */
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import type { TachoHarness } from "../wire";
import {
  handleHookEvent,
  type HookHandlerDeps,
  type PolicyView,
} from "./hook-handler";
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

const SESSION = "sess-memory-uses";
const FILE = "/home/dev/.claude/projects/-proj/memory/use-pnpm.md";

type Noted = Parameters<NonNullable<HookHandlerDeps["noteMemoryReads"]>>;

function harness() {
  const bundle = bundleSigner().sign(
    unsignedBundle({ context: { system: null } }),
  );
  let clock = Date.parse("2026-10-01T09:00:00.000Z");
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
  const noted: Noted[] = [];
  const deps: HookHandlerDeps = {
    registry,
    policy: () => view,
    acknowledge: () => undefined,
    now,
    noteMemoryReads: (call, run) => {
      noted.push([call, run]);
    },
  };
  return { registry, deps, view, noted };
}

const start = { session_id: SESSION, hook_event_name: "SessionStart" };

function toolHook(
  hook_event_name: string,
  extra: Record<string, unknown> = {},
) {
  return {
    session_id: SESSION,
    hook_event_name,
    cwd: "/repo",
    tool_name: "Read",
    tool_input: { file_path: FILE },
    tool_use_id: "toolu_read",
    tool_response: "Use pnpm.",
    ...extra,
  };
}

async function opened(h: ReturnType<typeof harness>, name?: TachoHarness) {
  await handleHookEvent(start, {}, h.deps, undefined, name);
  const record = h.registry.get(SESSION);
  if (record === undefined) throw new Error("no record");
  return record;
}

describe("memory reads at a tool call", () => {
  it("hands a Claude Code PostToolUse to noteMemoryReads with the run's root session", async () => {
    const h = harness();
    const record = await opened(h);
    await handleHookEvent(toolHook("PostToolUse"), {}, h.deps);
    expect(h.noted).toHaveLength(1);
    const [call, run] = h.noted[0] ?? [];
    expect(call).toEqual({
      toolName: "Read",
      toolInput: { file_path: FILE },
      cwd: "/repo",
    });
    expect(run?.sessionUuid).toBe(record.recorder.rootSessionUuid);
    expect(run?.sessionUuid).toBe(record.recorder.sessionUuid);
    expect(Number.isNaN(Date.parse(run?.at ?? ""))).toBe(false);
  });

  it("counts a subagent's read for the root run", async () => {
    const h = harness();
    const record = await opened(h);
    await handleHookEvent(
      toolHook("PostToolUse", { agent_id: "agent_1", agent_type: "Explore" }),
      {},
      h.deps,
    );
    expect(h.noted[0]?.[1].sessionUuid).toBe(record.recorder.rootSessionUuid);
  });

  it("uses the receive time of a replayed hook", async () => {
    const h = harness();
    await opened(h);
    await handleHookEvent(toolHook("PostToolUse"), {}, h.deps, {
      receivedAt: "2026-10-01T08:59:30.000Z",
    });
    expect(h.noted[0]?.[1].at).toBe("2026-10-01T08:59:30.000Z");
  });

  it("still counts a read in a session the operator paused", async () => {
    const h = harness();
    await opened(h);
    h.view.hostStatus = "paused";
    await handleHookEvent(toolHook("PostToolUse"), {}, h.deps);
    expect(h.noted).toHaveLength(1);
  });

  it("hands nothing over for a failed call", async () => {
    const h = harness();
    await opened(h);
    await handleHookEvent(
      toolHook("PostToolUseFailure", { error: "ENOENT" }),
      {},
      h.deps,
    );
    expect(h.noted).toEqual([]);
  });

  it.each(["codex", "cursor", "stella"] as const)(
    "hands nothing over for a %s session",
    async (name) => {
      const h = harness();
      await opened(h, name);
      await handleHookEvent(
        toolHook("PostToolUse"),
        {},
        h.deps,
        undefined,
        name,
      );
      expect(h.noted).toEqual([]);
    },
  );
});
