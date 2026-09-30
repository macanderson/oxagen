/**
 * The daemon's hook queues (#4601, ADR-229): a hook from one session does not
 * wait on a hook from another, and one session's hooks still run in the order
 * they arrived.
 *
 * Session A's prompt waits on its recalled memories, which the fake control
 * plane holds until the test answers. The daemon gives that ask 500 ms
 * (`MEMORY_RECALL_TIMEOUT_MS`). With one queue for the host, session B's
 * `PreToolUse` was answered only after A's prompt gave up on its recall.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../host/control-client";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type DaemonHandle, startDaemon } from "./daemon";
import { MEMORY_RECALL_PATH } from "./memory-capture/memory-recall";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function hook(
  sessionId: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  return {
    payload: {
      session_id: sessionId,
      hook_event_name: name,
      cwd: "/repo",
      ...extra,
    },
    env: {},
  };
}

/** A `PreToolUse` for a read the bundle allows. */
function read(sessionId: string, toolUseId: string) {
  return hook(sessionId, "PreToolUse", {
    tool_name: "Read",
    tool_input: { file_path: "README.md" },
    tool_use_id: toolUseId,
  });
}

/** A control plane that holds every memory recall until the test answers. */
function heldRecall() {
  let started = (): void => undefined;
  const asked = new Promise<void>((resolve) => {
    started = resolve;
  });
  let answer = (): void => undefined;
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const fetch: FetchLike = async (url) => {
    if (url.endsWith(MEMORY_RECALL_PATH)) {
      started();
      await answered;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ items: [] }),
      };
    }
    throw new Error("ECONNREFUSED");
  };
  return { fetch, asked, answer };
}

describe("the daemon's hook queues", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(fetch: FetchLike): Promise<DaemonHandle> {
    const paths = scratchPaths();
    const signer = bundleSigner();
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    const handle = await startDaemon({
      paths,
      fetch,
      exec: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      log: () => undefined,
      listen: false,
      // On for a daemon that listens. Asked for here, since this one does not.
      memoryRecall: true,
      transcriptRoots: [`${paths.tachoDir}/no-transcripts`],
      timers: {
        detectorMs: 60 * 60_000,
        sweepMs: 60 * 60_000,
        checkpointMs: 60 * 60_000,
      },
    });
    handles.push(handle);
    return handle;
  }

  it("answers session B's PreToolUse while session A's prompt waits on its recall", async () => {
    const plane = heldRecall();
    const handle = await boot(plane.fetch);
    await handle.api.handleHook(hook(A, "SessionStart"));
    await handle.api.handleHook(hook(B, "SessionStart"));
    let promptAnswered = false;
    const prompt = handle.api
      .handleHook(hook(A, "UserPromptSubmit", { prompt: "what changed?" }))
      .then(() => {
        promptAnswered = true;
      });
    try {
      await plane.asked;
      const answer = await handle.api.handleHook(read(B, "toolu_b"));
      expect(answer).toBeDefined();
      // B was answered while A's prompt still waited on the control plane.
      expect(promptAnswered).toBe(false);
    } finally {
      plane.answer();
      await prompt;
    }
    expect(promptAnswered).toBe(true);
  });

  it("runs one session's hooks in the order they arrived", async () => {
    const plane = heldRecall();
    const handle = await boot(plane.fetch);
    await handle.api.handleHook(hook(A, "SessionStart"));
    await handle.api.handleHook(hook(B, "SessionStart"));
    const order: string[] = [];
    const prompt = handle.api
      .handleHook(hook(A, "UserPromptSubmit", { prompt: "go" }))
      .then(() => {
        order.push("A prompt");
      });
    let toolA: Promise<void> = Promise.resolve();
    try {
      await plane.asked;
      // A's tool call arrives while A's prompt waits: it waits too.
      toolA = handle.api.handleHook(read(A, "toolu_a")).then(() => {
        order.push("A tool");
      });
      await handle.api.handleHook(read(B, "toolu_b"));
      order.push("B tool");
      expect(order).toEqual(["B tool"]);
    } finally {
      plane.answer();
      await Promise.all([prompt, toolA]);
    }
    expect(order).toEqual(["B tool", "A prompt", "A tool"]);
    // A's chain holds its prompt's turn before the tool call it made next.
    const uuid = handle.registry.get(A)?.recorder.sessionUuid ?? "";
    const kinds = handle.wal.read(uuid).map((event) => event.kind);
    expect(kinds).toContain("turn_start");
    expect(kinds).toContain("tool_requested");
    expect(kinds.indexOf("turn_start")).toBeLessThan(
      kinds.indexOf("tool_requested"),
    );
  });
});
