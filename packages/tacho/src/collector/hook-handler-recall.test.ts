/**
 * A live prompt asks the control plane for the memories most relevant to it
 * and hands them to the agent after the operator's messages, within what the
 * answer has left (#4458). A blocked or replayed prompt asks nothing, and
 * neither does a prompt of Stella or Cursor, whose prompt answers carry no
 * text to the agent. The ask names the session's repository by its remote's
 * digests, and the tools and files the session used, most recent first.
 */
import { describe, expect, it } from "vitest";
import { type ClaudeCodeContext, digestText } from "../claude-code/context";
import { digestBytes } from "../digest";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import type { TachoHarness } from "../wire";
import type { RepositoryRemote } from "./git-facts";
import {
  ADDITIONAL_CONTEXT_MAX_CHARS,
  handleHookEvent,
  type HookHandlerDeps,
  type PolicyView,
  RECALL_HEADING,
} from "./hook-handler";
import type {
  MemoryRecallRequest,
  RecalledMemory,
} from "./memory-capture/memory-recall";
import { RECALL_PATHS_KEPT, RECALL_TOOLS_KEPT } from "./recall-hints";
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

const SESSION = "sess-recall";

const MEMORIES: RecalledMemory[] = [
  { id: "a-intel.memory.pnpm", statement: "Use pnpm,\n  never npm." },
  { id: "mem_01", statement: "Run the gate in CI." },
];

/** The repository the sessions below run in, rooted at `/repo`. */
const REMOTE: RepositoryRemote = {
  remote_digest: digestBytes("github.com/acme/widgets"),
  remote_digest_folded: digestBytes("github.com/acme/widgets.folded"),
  name: "widgets",
  root: "/repo",
};

/**
 * A harness that recalls `memories`. Given `remote`, it also reads the
 * session's repository, and `reads` lists the directory of each read.
 */
function harness(
  memories: readonly RecalledMemory[] = MEMORIES,
  remote?: () => Promise<RepositoryRemote | undefined>,
) {
  const bundle = bundleSigner().sign(unsignedBundle({ context: { system: null } }));
  let clock = Date.parse("2026-09-27T01:00:00.000Z");
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
  const asked: MemoryRecallRequest[] = [];
  const deps: HookHandlerDeps = {
    registry,
    policy: () => view,
    acknowledge: () => undefined,
    now,
    recallMemories: async (request) => {
      asked.push(request);
      return memories;
    },
  };
  const reads: string[] = [];
  if (remote !== undefined)
    deps.repositoryRemote = (cwd) => {
      reads.push(cwd);
      return remote();
    };
  return { registry, deps, asked, view, reads };
}

function message(id: string, text: string): QueuedPrompt {
  return {
    id,
    text,
    command: "steer",
    requestedMode: "next_step",
    deliveryMode: "next_step",
    degradedReason: null,
    expiresAt: null,
  };
}

const start = { session_id: SESSION, hook_event_name: "SessionStart" };
const prompt = {
  session_id: SESSION,
  hook_event_name: "UserPromptSubmit",
  prompt: "How do I install?",
};

function contextOf(response: Record<string, unknown>): string | undefined {
  const specific = response["hookSpecificOutput"] as
    | { additionalContext?: string }
    | undefined;
  return specific?.additionalContext;
}

async function opened(h: ReturnType<typeof harness>, name?: TachoHarness) {
  await handleHookEvent(start, {}, h.deps, undefined, name);
  const record = h.registry.get(SESSION);
  if (record === undefined) throw new Error("no record");
  return record;
}

const EXPECTED = `${RECALL_HEADING}\n- Use pnpm, never npm.\n- Run the gate in CI.`;

describe("memory recall at a prompt", () => {
  it("hands a live prompt its recalled memories, one line each", async () => {
    const h = harness();
    await opened(h);
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    expect(h.asked).toEqual([
      {
        repositoryDigests: [],
        tools: [],
        paths: [],
        text: "How do I install?",
      },
    ]);
    expect(outcome.response).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: EXPECTED,
      },
    });
    const turn = outcome.events.find((event) => event.kind === "turn_start");
    expect(turn?.attrs["oxagen.recall_digest"]).toBe(digestText(EXPECTED));
    expect(turn?.attrs["oxagen.recalled_memories"]).toBe("2");
  });

  it("adds nothing when the control plane recalls nothing", async () => {
    const h = harness([]);
    await opened(h);
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    expect(h.asked).toHaveLength(1);
    expect(outcome.response).toEqual({});
    const turn = outcome.events.find((event) => event.kind === "turn_start");
    expect(turn?.attrs["oxagen.recall_digest"]).toBeUndefined();
    expect(turn?.attrs["oxagen.recalled_memories"]).toBeUndefined();
  });

  it("asks nothing for a prompt the operator blocked", async () => {
    const h = harness();
    await opened(h);
    h.view.hostStatus = "paused";
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    expect(outcome.response).toMatchObject({ decision: "block" });
    expect(h.asked).toEqual([]);
  });

  it("asks nothing for a replayed prompt, which the harness already sent on", async () => {
    const h = harness();
    await opened(h);
    await handleHookEvent(prompt, {}, h.deps, {
      receivedAt: "2026-09-27T01:00:05.000Z",
    });
    expect(h.asked).toEqual([]);
  });

  it.each(["stella", "cursor"] as const)(
    "asks nothing for a %s prompt, whose answer carries no text to the agent",
    async (name) => {
      const h = harness();
      await opened(h, name);
      const outcome = await handleHookEvent(prompt, {}, h.deps, undefined, name);
      expect(h.asked).toEqual([]);
      expect(contextOf(outcome.response)).toBeUndefined();
    },
  );

  it("asks for a Codex prompt, whose answer the agent reads", async () => {
    const h = harness();
    await opened(h, "codex");
    const outcome = await handleHookEvent(prompt, {}, h.deps, undefined, "codex");
    expect(h.asked).toHaveLength(1);
    expect(contextOf(outcome.response)).toBe(EXPECTED);
  });

  it("puts the memories after the operator's messages", async () => {
    const h = harness();
    const record = await opened(h);
    record.control.messages.push(message("cmd_1", "Stop and read the brief."));
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    expect(contextOf(outcome.response)).toBe(
      `Stop and read the brief.\n\n${EXPECTED}`,
    );
  });

  it("leaves out a memory that does not fit beside the messages, and keeps a shorter one after it", async () => {
    const long = "l".repeat(400);
    const h = harness([
      { id: "long", statement: long },
      { id: "short", statement: "Use pnpm." },
    ]);
    const record = await opened(h);
    // The message leaves room for the heading and the short memory only.
    const filler = "f".repeat(
      ADDITIONAL_CONTEXT_MAX_CHARS -
        "\n\n".length -
        RECALL_HEADING.length -
        "\n- Use pnpm.".length,
    );
    record.control.messages.push(message("cmd_fill", filler));
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    const text = contextOf(outcome.response);
    expect(text).toBe(`${filler}\n\n${RECALL_HEADING}\n- Use pnpm.`);
    expect(text?.length).toBe(ADDITIONAL_CONTEXT_MAX_CHARS);
    const turn = outcome.events.find((event) => event.kind === "turn_start");
    expect(turn?.attrs["oxagen.recalled_memories"]).toBe("1");
  });

  it("adds nothing when no memory fits beside the messages", async () => {
    const h = harness();
    const record = await opened(h);
    const filler = "f".repeat(ADDITIONAL_CONTEXT_MAX_CHARS - 10);
    record.control.messages.push(message("cmd_fill", filler));
    const outcome = await handleHookEvent(prompt, {}, h.deps);
    expect(contextOf(outcome.response)).toBe(filler);
  });
});

/** Lets the repository read a hook started settle before the next hook. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const IN_REPO = { cwd: "/repo" };

/** A tool call in `/repo`, allowed by the test bundle's permissions. */
function toolHook(
  tool_name: string,
  tool_input: Record<string, unknown>,
  id: string,
) {
  return {
    session_id: SESSION,
    hook_event_name: "PreToolUse",
    ...IN_REPO,
    tool_name,
    tool_input,
    tool_use_id: `toolu_${id}`,
  };
}

async function openedInRepo(h: ReturnType<typeof harness>) {
  await handleHookEvent({ ...start, ...IN_REPO }, {}, h.deps);
  await settle();
}

async function recallFor(h: ReturnType<typeof harness>, text?: string) {
  await handleHookEvent(
    { ...prompt, ...IN_REPO, ...(text !== undefined ? { prompt: text } : {}) },
    {},
    h.deps,
  );
  const request = h.asked.at(-1);
  if (request === undefined) throw new Error("no recall");
  return request;
}

const DIGESTS = [REMOTE.remote_digest, REMOTE.remote_digest_folded];

describe("what a recall names", () => {
  it("sends both digests and reads the remote once a session", async () => {
    const h = harness(MEMORIES, async () => REMOTE);
    await openedInRepo(h);
    await handleHookEvent(
      toolHook("Read", { file_path: "/repo/README.md" }, "readme"),
      {},
      h.deps,
    );
    const first = await recallFor(h);
    const second = await recallFor(h, "And then?");
    expect(h.reads).toEqual(["/repo"]);
    expect(first.repositoryDigests).toEqual(DIGESTS);
    expect(second.repositoryDigests).toEqual(DIGESTS);
  });

  it("sends the tools and files the session used, newest first", async () => {
    const h = harness(MEMORIES, async () => REMOTE);
    await openedInRepo(h);
    const calls = [
      toolHook("Read", { file_path: "/repo/src/a.ts" }, "a"),
      toolHook("mcp__github__get_issue", { path: "docs/guide.md" }, "b"),
      toolHook("Read", { notebook_path: "/repo/nb/analysis.ipynb" }, "c"),
    ];
    for (const call of calls) await handleHookEvent(call, {}, h.deps);
    expect(await recallFor(h)).toEqual({
      repositoryDigests: DIGESTS,
      // The second Read moved its tool back to the front.
      tools: ["Read", "mcp__github__get_issue"],
      paths: ["nb/analysis.ipynb", "docs/guide.md", "src/a.ts"],
      text: "How do I install?",
    });
  });

  it("keeps the newest 32 tools", async () => {
    const h = harness(MEMORIES, async () => REMOTE);
    await openedInRepo(h);
    for (let i = 0; i <= RECALL_TOOLS_KEPT; i += 1)
      await handleHookEvent(
        toolHook(`mcp__github__tool_${i}`, {}, `t${i}`),
        {},
        h.deps,
      );
    const { tools } = await recallFor(h);
    expect(RECALL_TOOLS_KEPT).toBe(32);
    expect(tools).toHaveLength(RECALL_TOOLS_KEPT);
    expect(tools[0]).toBe(`mcp__github__tool_${RECALL_TOOLS_KEPT}`);
    expect(tools.at(-1)).toBe("mcp__github__tool_1");
    expect(tools).not.toContain("mcp__github__tool_0");
  });

  it("keeps the newest 64 files", async () => {
    const h = harness(MEMORIES, async () => REMOTE);
    await openedInRepo(h);
    for (let i = 0; i <= RECALL_PATHS_KEPT; i += 1)
      await handleHookEvent(
        toolHook("Read", { file_path: `/repo/src/file-${i}.ts` }, `p${i}`),
        {},
        h.deps,
      );
    const { paths } = await recallFor(h);
    expect(RECALL_PATHS_KEPT).toBe(64);
    expect(paths).toHaveLength(RECALL_PATHS_KEPT);
    expect(paths[0]).toBe(`src/file-${RECALL_PATHS_KEPT}.ts`);
    expect(paths.at(-1)).toBe("src/file-1.ts");
    expect(paths).not.toContain("src/file-0.ts");
  });

  it("moves a file used again to the front", async () => {
    const h = harness(MEMORIES, async () => REMOTE);
    await openedInRepo(h);
    const calls = [
      toolHook("Read", { file_path: "/repo/src/a.ts" }, "a1"),
      toolHook("Read", { file_path: "/repo/src/b.ts" }, "b"),
      toolHook("Read", { file_path: "/repo/src/a.ts" }, "a2"),
    ];
    for (const call of calls) await handleHookEvent(call, {}, h.deps);
    expect((await recallFor(h)).paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("names files from the root and drops any it cannot name", async () => {
    const h = harness(MEMORIES, async () => REMOTE);
    await openedInRepo(h);
    const calls = [
      toolHook("Read", { file_path: "/elsewhere/notes.md" }, "out"),
      toolHook("Read", { file_path: "/repo/src/in.ts" }, "in"),
      toolHook("Read", { file_path: "/repo" }, "root"),
    ];
    for (const call of calls) await handleHookEvent(call, {}, h.deps);
    expect((await recallFor(h)).paths).toEqual(["src/in.ts"]);
  });

  it("sends no repository or files while the read runs", async () => {
    const h = harness(
      MEMORIES,
      () => new Promise<RepositoryRemote | undefined>(() => undefined),
    );
    await openedInRepo(h);
    await handleHookEvent(
      toolHook("Read", { file_path: "/repo/src/a.ts" }, "a"),
      {},
      h.deps,
    );
    expect(await recallFor(h)).toEqual({
      repositoryDigests: [],
      tools: ["Read"],
      paths: [],
      text: "How do I install?",
    });
  });

  it("sends no files when the read found no root", async () => {
    const rootless: RepositoryRemote = {
      remote_digest: REMOTE.remote_digest,
      remote_digest_folded: REMOTE.remote_digest_folded,
    };
    const h = harness(MEMORIES, async () => rootless);
    await openedInRepo(h);
    await handleHookEvent(
      toolHook("Read", { file_path: "/repo/src/a.ts" }, "a"),
      {},
      h.deps,
    );
    const request = await recallFor(h);
    expect(request.repositoryDigests).toEqual(DIGESTS);
    expect(request.paths).toEqual([]);
  });

  it("forgets the recall hints when the session ends", async () => {
    const h = harness(MEMORIES, async () => REMOTE);
    await openedInRepo(h);
    await handleHookEvent(
      toolHook("Read", { file_path: "/repo/src/a.ts" }, "a"),
      {},
      h.deps,
    );
    expect(h.registry.get(SESSION)?.recallHints?.tools).toEqual(["Read"]);
    await handleHookEvent(
      { session_id: SESSION, hook_event_name: "SessionEnd", ...IN_REPO },
      {},
      h.deps,
    );
    expect(h.registry.get(SESSION)?.recallHints).toBeUndefined();
  });

  it.each(["stella", "cursor"] as const)(
    "reads no repository for a %s session, whose prompts recall nothing",
    async (name) => {
      const h = harness(MEMORIES, async () => REMOTE);
      const hook = { ...start, ...IN_REPO };
      await handleHookEvent(hook, {}, h.deps, undefined, name);
      await settle();
      expect(h.reads).toEqual([]);
    },
  );

  it("reads no repository for a replayed hook", async () => {
    const h = harness(MEMORIES, async () => REMOTE);
    await handleHookEvent({ ...start, ...IN_REPO }, {}, h.deps, {
      receivedAt: "2026-09-27T01:00:05.000Z",
    });
    await settle();
    expect(h.reads).toEqual([]);
  });
});
