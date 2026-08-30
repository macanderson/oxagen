/**
 * Tests for detached session dispatch — the fire-and-forget path shared by
 * `oxagen fleet dispatch` and the REPL's trailing-`&`. Asserts the store side
 * (session created, worker-owned, options recorded) and the exact re-exec
 * spawn contract, with the process fork stubbed out.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dispatchDetachedSession,
  parseAmpersandDispatch,
  titleFromPrompt,
} from "../dispatch.js";
import { SessionStore } from "../store.js";

let root: string;
let store: SessionStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oxagen-dispatch-"));
  store = new SessionStore({ root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("titleFromPrompt", () => {
  it("collapses whitespace and keeps short prompts whole", () => {
    expect(titleFromPrompt("  fix\n the   bug ")).toBe("fix the bug");
  });

  it("clips at 64 with an ellipsis", () => {
    const title = titleFromPrompt("x".repeat(100));
    expect(title.length).toBe(62);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("parseAmpersandDispatch (REPL trailing-& idiom)", () => {
  it("strips the marker and returns the prompt", () => {
    expect(parseAmpersandDispatch("fix the login bug &")).toBe(
      "fix the login bug",
    );
    expect(parseAmpersandDispatch("fix it\t&")).toBe("fix it");
  });

  it("requires whitespace before the ampersand (mid-word & is prose)", () => {
    expect(parseAmpersandDispatch("audit auth&billing")).toBeNull();
    expect(parseAmpersandDispatch("audit auth & billing")).toBeNull();
  });

  it("never backgrounds slash or shell commands, or an empty prompt", () => {
    expect(parseAmpersandDispatch("/fleet &")).toBeNull();
    expect(parseAmpersandDispatch("!ls &")).toBeNull();
    expect(parseAmpersandDispatch(" &")).toBeNull();
  });
});

describe("dispatchDetachedSession", () => {
  it("creates a worker-owned session and spawns the detached worker", async () => {
    const calls: Array<{ command: string; args: string[]; options: object }> =
      [];
    let unrefed = false;
    const { sid, title } = await dispatchDetachedSession({
      cwd: "/some/project",
      prompt: "refactor the auth flow",
      model: "sonnet-5",
      agent: "reviewer",
      store,
      spawnImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return {
          unref: () => {
            unrefed = true;
          },
          pid: 4242,
        };
      },
    });

    expect(title).toBe("refactor the auth flow");
    const meta = await store.readMeta(sid);
    expect(meta).toMatchObject({
      sid,
      title,
      prompt: "refactor the auth flow",
      owner: "worker",
      pid: 0,
      cwd: "/some/project",
      mode: "conversation",
      model: "sonnet-5",
      agent: "reviewer",
      state: "queued",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0] as (typeof calls)[0];
    expect(call.command).toBe(process.execPath);
    expect(call.args.slice(-3)).toEqual(["fleet", "worker", sid]);
    expect(call.options).toEqual({
      cwd: "/some/project",
      detached: true,
      stdio: "ignore",
    });
    expect(unrefed).toBe(true);
  });

  it("records once mode when asked", async () => {
    const { sid } = await dispatchDetachedSession({
      cwd: "/p",
      prompt: "one and done",
      mode: "once",
      store,
      spawnImpl: () => ({ unref: () => undefined }),
    });
    expect((await store.readMeta(sid))?.mode).toBe("once");
  });

  it("rejects an empty prompt before touching the store", async () => {
    await expect(
      dispatchDetachedSession({
        cwd: "/p",
        prompt: "   ",
        store,
        spawnImpl: () => ({ unref: () => undefined }),
      }),
    ).rejects.toThrow(/non-empty prompt/);
    expect(await store.listSessions()).toEqual([]);
  });
});
