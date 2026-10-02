/**
 * Memory recall reads the session's repository from the directory the agent
 * last wrote a file in (#4458). A denied or failed write wrote nothing, so it
 * leaves that directory where it was. The git lane still reads the directory
 * of a write the agent is about to make (#4003), from `workDir`.
 */
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import { digestBytes } from "../digest";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import type { RepositoryRemote } from "./git-facts";
import {
  handleHookEvent,
  type HookHandlerDeps,
  type PolicyView,
} from "./hook-handler";
import type { MemoryRecallRequest } from "./memory-capture/memory-recall";
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

const SESSION = "sess-written-dir";

function remote(name: string, root: string): RepositoryRemote {
  return {
    remote_digest: digestBytes(`github.com/acme/${name}`),
    remote_digest_folded: digestBytes(`github.com/acme/${name}.folded`),
    name,
    root,
  };
}

/** The repository the session starts in. */
const REPO = remote("widgets", "/repo");
/** A repository the agent writes in. */
const OTHER = remote("gadgets", "/other/repo");
/** A repository the policy refuses writes in. */
const DENIED = remote("secrets", "/denied/repo");

const REMOTES = [REPO, OTHER, DENIED];

function digestsOf(read: RepositoryRemote): string[] {
  return [read.remote_digest, read.remote_digest_folded];
}

/**
 * A Claude Code session that recalls memories and reads the repository of
 * any directory under one of `REMOTES`. `reads` lists the directory of each
 * repository read, and `asked` each recall request.
 */
function harness() {
  const bundle = bundleSigner().sign(
    unsignedBundle({
      context: { system: null },
      permissions: {
        allow: ["Read"],
        deny: ["Write(//denied/**)"],
        ask: [],
      },
    }),
  );
  let clock = Date.parse("2026-10-02T01:00:00.000Z");
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
  const reads: string[] = [];
  const deps: HookHandlerDeps = {
    registry,
    policy: () => view,
    acknowledge: () => undefined,
    now,
    recallMemories: async (request) => {
      asked.push(request);
      return [];
    },
    repositoryRemote: async (dir) => {
      reads.push(dir);
      return REMOTES.find(
        ({ root }) => dir === root || dir.startsWith(`${root}/`),
      );
    },
  };
  return { registry, deps, asked, reads };
}

type Harness = ReturnType<typeof harness>;

/** Lets the repository read a hook started settle before the next hook. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const IN_REPO = { session_id: SESSION, cwd: "/repo" };

async function openedInRepo(h: Harness): Promise<void> {
  await handleHookEvent(
    { ...IN_REPO, hook_event_name: "SessionStart" },
    {},
    h.deps,
  );
  await settle();
}

/** One hook of a `Write` call to `file_path`. */
function writeHook(hook_event_name: string, file_path: string, id: string) {
  return {
    ...IN_REPO,
    hook_event_name,
    tool_name: "Write",
    tool_input: { file_path, content: "x" },
    tool_use_id: `toolu_${id}`,
  };
}

async function recallFor(h: Harness): Promise<MemoryRecallRequest> {
  await handleHookEvent(
    { ...IN_REPO, hook_event_name: "UserPromptSubmit", prompt: "Next?" },
    {},
    h.deps,
  );
  const request = h.asked.at(-1);
  if (request === undefined) throw new Error("no recall");
  return request;
}

const DENY = { hookSpecificOutput: { permissionDecision: "deny" } };

describe("the directory memory recall reads its repository from", () => {
  it("stays put when the policy denies a write", async () => {
    const h = harness();
    await openedInRepo(h);
    const outcome = await handleHookEvent(
      writeHook("PreToolUse", "/denied/repo/a.ts", "denied"),
      {},
      h.deps,
    );
    expect(outcome.response).toMatchObject(DENY);
    await settle();
    const request = await recallFor(h);
    expect(h.reads).toEqual(["/repo"]);
    expect(request.repositoryDigests).toEqual(digestsOf(REPO));
  });

  it("stays put when a write fails", async () => {
    const h = harness();
    await openedInRepo(h);
    await handleHookEvent(
      writeHook("PreToolUse", "/other/repo/a.ts", "failed"),
      {},
      h.deps,
    );
    await handleHookEvent(
      {
        ...writeHook("PostToolUseFailure", "/other/repo/a.ts", "failed"),
        error: "EACCES: permission denied",
      },
      {},
      h.deps,
    );
    await settle();
    const request = await recallFor(h);
    expect(h.reads).toEqual(["/repo"]);
    expect(request.repositoryDigests).toEqual(digestsOf(REPO));
  });

  it("moves to the directory of a write that succeeded", async () => {
    const h = harness();
    await openedInRepo(h);
    const pre = await handleHookEvent(
      writeHook("PreToolUse", "/other/repo/a.ts", "ok"),
      {},
      h.deps,
    );
    expect(pre.response).not.toMatchObject(DENY);
    await handleHookEvent(
      writeHook("PostToolUse", "/other/repo/a.ts", "ok"),
      {},
      h.deps,
    );
    await settle();
    const request = await recallFor(h);
    expect(h.reads).toEqual(["/repo", "/other/repo"]);
    expect(request.repositoryDigests).toEqual(digestsOf(OTHER));
  });

  it("leaves the git lane the directory of a write before it runs", async () => {
    // The git lane takes a new checkout's baseline from `workDir` before the
    // write lands, so the write counts as the session's own edit (#4003).
    const h = harness();
    await openedInRepo(h);
    await handleHookEvent(
      writeHook("PreToolUse", "/other/repo/a.ts", "pending"),
      {},
      h.deps,
    );
    await settle();
    expect(h.registry.get(SESSION)?.workDir).toBe("/other/repo");
    expect(h.reads).toEqual(["/repo"]);
  });

  it("starts from the restored workDir after a restart", async () => {
    // A restart restores `workDir` from the state file into a record this
    // handler has not seen yet.
    const h = harness();
    h.registry.ensure(SESSION, {
      ambient: false,
      cwd: "/repo",
      workDir: "/other/repo",
    });
    await openedInRepo(h);
    await handleHookEvent(
      writeHook("PreToolUse", "/denied/repo/a.ts", "denied"),
      {},
      h.deps,
    );
    await settle();
    const request = await recallFor(h);
    expect(h.reads).toEqual(["/other/repo"]);
    expect(request.repositoryDigests).toEqual(digestsOf(OTHER));
  });
});
