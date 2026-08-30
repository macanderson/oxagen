/**
 * FleetSessionManager tests (ADR-023) — drive the manager with a FAKE
 * `runSession` and a tmpdir store, asserting the four behaviours the ADR turns
 * on: immediate synchronous dispatch, the concurrency cap + FIFO queue, detached
 * worker spawn, and foreign-session adoption WITHOUT double-emitting an
 * in-process session's events.
 *
 * The tail invariant (own sessions come from the runner's bus, never from a disk
 * tail) is asserted DETERMINISTICALLY by spying on `store.tailEvents` — no
 * timing-based negative. All waits are poll-based (`until`) against a deadline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_SCHEMA_VERSION, type SessionEvent } from "../events.js";
import type { InboxMessage, SessionMetaView } from "../store.js";
import type { FleetSessionManagerOptions } from "../manager.js";

const { SessionStore } = await import("../store.js");
const { newSessionId } = await import("../ids.js");
const { FleetSessionManager } = await import("../manager.js");

// ── Test helpers ─────────────────────────────────────────────────────────────

const tick = (ms = 10): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until(
  cond: () => boolean,
  timeoutMs = 4000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error("until(): condition not met before deadline");
    await tick(stepMs);
  }
}

/** A `runSession` that blocks each session until its sid is released — for the cap test. */
function controlledRunner(): {
  impl: FleetSessionManagerOptions["runSessionImpl"];
  started: string[];
  releasers: Map<string, () => void>;
} {
  const started: string[] = [];
  const releasers = new Map<string, () => void>();
  const impl: FleetSessionManagerOptions["runSessionImpl"] = async (opts) => {
    started.push(opts.meta.sid);
    // The executor runs synchronously, so `releasers` has the sid before we await.
    await new Promise<void>((resolve) => releasers.set(opts.meta.sid, resolve));
    return { state: "done" };
  };
  return { impl, started, releasers };
}

/** A `runSession` that emits one bus event then completes — for observation tests. */
const emittingRunner: FleetSessionManagerOptions["runSessionImpl"] = async (
  opts,
) => {
  opts.onLocalEvent?.({
    v: EVENT_SCHEMA_VERSION,
    sid: opts.meta.sid,
    seq: 1,
    ts: Date.now(),
    type: "session.start",
    title: opts.meta.title,
    prompt: opts.meta.prompt,
    cwd: opts.meta.cwd,
    mode: opts.meta.mode,
    owner: opts.meta.owner,
    pid: opts.meta.pid,
  });
  return { state: "done" };
};

// ── Fixtures ─────────────────────────────────────────────────────────────────

let root: string;
let cwd: string;
let store: InstanceType<typeof SessionStore>;
let manager: InstanceType<typeof FleetSessionManager> | null;
let savedDisableMemory: string | undefined;

beforeEach(async () => {
  savedDisableMemory = process.env["OXAGEN_DISABLE_MEMORY"];
  process.env["OXAGEN_DISABLE_MEMORY"] = "1";
  const base = await mkdtemp(join(tmpdir(), "oxagen-manager-"));
  root = join(base, "fleet");
  cwd = join(base, "cwd");
  await mkdir(root, { recursive: true });
  await mkdir(cwd, { recursive: true });
  store = new SessionStore({ root });
  manager = null;
});

afterEach(async () => {
  manager?.stop();
  if (savedDisableMemory === undefined)
    delete process.env["OXAGEN_DISABLE_MEMORY"];
  else process.env["OXAGEN_DISABLE_MEMORY"] = savedDisableMemory;
  vi.restoreAllMocks();
  await rm(join(root, ".."), { recursive: true, force: true }).catch(() => {});
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("FleetSessionManager — dispatch, cap, queue", () => {
  it("returns a sid synchronously and respects the concurrency cap (1 running, 2 queued)", async () => {
    const { impl, started, releasers } = controlledRunner();
    manager = new FleetSessionManager({
      store,
      cwd,
      concurrency: 1,
      runSessionImpl: impl,
    });

    const s1 = manager.dispatch({ prompt: "one" });
    const s2 = manager.dispatch({ prompt: "two" });
    const s3 = manager.dispatch({ prompt: "three" });

    // Synchronous, distinct, well-formed sids.
    for (const s of [s1, s2, s3])
      expect(s).toMatch(/^s-[0-9a-z]+-[0-9a-z]{4}$/);
    expect(new Set([s1, s2, s3]).size).toBe(3);

    // Cap: exactly one runner, two queued.
    await until(
      () => manager!.runningCount === 1 && manager!.queuedCount === 2,
    );

    // Release each running session in turn; the next dequeues (FIFO) and starts.
    for (let i = 0; i < 3; i++) {
      await until(() => started.length >= i + 1);
      releasers.get(started[i] as string)?.();
      if (i < 2) await until(() => started.length >= i + 2);
    }

    await until(
      () => manager!.runningCount === 0 && manager!.queuedCount === 0,
    );
    expect(started.length).toBe(3);
    expect(new Set(started)).toEqual(new Set([s1, s2, s3]));
  });

  it("drain cancels queued sessions and waits for the running one to settle", async () => {
    const { impl, started, releasers } = controlledRunner();
    manager = new FleetSessionManager({
      store,
      cwd,
      concurrency: 1,
      runSessionImpl: impl,
    });

    const sids = [
      manager.dispatch({ prompt: "one" }),
      manager.dispatch({ prompt: "two" }),
      manager.dispatch({ prompt: "three" }),
    ];
    await until(
      () => manager!.runningCount === 1 && manager!.queuedCount === 2,
    );

    // dispatch's createSession is async, so whichever won the race is the one running.
    const runningSid = started[0] as string;

    // Drain: the 2 queued are finalized cancelled; releasing the running one lets drain settle.
    const drainPromise = manager.drain();
    releasers.get(runningSid)?.();
    await drainPromise;

    expect(manager.runningCount).toBe(0);
    expect(manager.queuedCount).toBe(0);
    expect(started).toEqual([runningSid]); // only the running one ever started

    for (const sid of sids.filter((s) => s !== runningSid)) {
      const meta = await store.readMeta(sid);
      expect(meta?.state).toBe("cancelled");
    }
  });
});

describe("FleetSessionManager — control channel", () => {
  it("send appends a message to the session inbox", async () => {
    manager = new FleetSessionManager({ store, cwd });
    const meta = await store.createSession({
      sid: newSessionId(),
      title: "t",
      prompt: "p",
      owner: "worker",
      pid: 0,
      cwd,
      mode: "once",
      state: "queued",
    });
    const inbox: InboxMessage[] = [];
    const tail = store.tailInbox(meta.sid, (m) => inbox.push(m));

    await manager.send(meta.sid, "please also add tests");
    await until(() =>
      inbox.some(
        (m) => m.type === "message" && m.text === "please also add tests",
      ),
    );
    tail.stop();
  });

  it("cancel appends a cancel and never signals an in-process session", async () => {
    const killSpy = vi.spyOn(process, "kill");
    manager = new FleetSessionManager({
      store,
      cwd,
      runSessionImpl: emittingRunner,
    });
    const sid = manager.dispatch({ prompt: "own work" });
    await pollMetaExists(store, sid);

    const inbox: InboxMessage[] = [];
    const tail = store.tailInbox(sid, (m) => inbox.push(m));
    await manager.cancel(sid);
    await until(() => inbox.some((m) => m.type === "cancel"));

    // An in-process (owned) session is cancelled via its inbox only — never
    // SIGTERM. (Signal-0 liveness probes from readMeta are expected and ignored.)
    const sigterms = killSpy.mock.calls.filter((call) => call[1] === "SIGTERM");
    expect(sigterms).toHaveLength(0);
    tail.stop();
  });

  it("cancel also SIGTERMs a foreign, alive worker", async () => {
    // Intercept SIGTERM so we never actually signal the test runner; delegate the
    // signal-0 liveness probe to the real implementation so the pid reads alive.
    const realKill = process.kill.bind(process);
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid: number, signal?: string | number) => {
        if (signal === "SIGTERM") return true; // recorded, but not delivered
        return realKill(pid, signal as NodeJS.Signals | number);
      });

    manager = new FleetSessionManager({ store, cwd });
    // A foreign worker owned by an ALIVE pid (this process) — not in ownSids.
    const meta = await store.createSession({
      sid: newSessionId(),
      title: "foreign worker",
      prompt: "p",
      owner: "worker",
      pid: process.pid,
      cwd,
      mode: "once",
      state: "running",
    });

    await manager.cancel(meta.sid);

    const sigterms = killSpy.mock.calls.filter((call) => call[1] === "SIGTERM");
    expect(sigterms).toHaveLength(1);
    expect(sigterms[0]?.[0]).toBe(process.pid);
  });
});

describe("FleetSessionManager — detached dispatch", () => {
  it("delegates to dispatchDetachedSession, spawning a worker with the sid", async () => {
    const spawnCalls: Array<[string, string[], unknown]> = [];
    const spawnImpl: FleetSessionManagerOptions["spawnImpl"] = (
      command,
      args,
      options,
    ) => {
      spawnCalls.push([command, args, options]);
      return { unref: () => {} };
    };
    manager = new FleetSessionManager({ store, cwd, spawnImpl });

    const sid = await manager.dispatchDetached({ prompt: "detached work" });

    // The shared dispatch path re-execs `node <cli> fleet worker <sid>`.
    expect(spawnCalls).toHaveLength(1);
    const [bin, args, options] = spawnCalls[0] as [string, string[], unknown];
    expect(bin).toBe(process.execPath);
    expect(args).toContain("fleet");
    expect(args).toContain("worker");
    expect(args).toContain(sid);
    expect(options).toMatchObject({ cwd, detached: true, stdio: "ignore" });

    // The session it created is a conversational worker (owner worker, pid 0).
    const meta = await store.readMeta(sid);
    expect(meta?.owner).toBe("worker");
    expect(meta?.pid).toBe(0);
    expect(meta?.mode).toBe("conversation"); // conversational by default (ADR-023 §5, spec §3)
  });
});

describe("FleetSessionManager — aggregate observation", () => {
  it("adopts a foreign session's events + roster, and never tails its own", async () => {
    const tailSpy = vi.spyOn(store, "tailEvents");
    manager = new FleetSessionManager({
      store,
      cwd,
      runSessionImpl: emittingRunner,
    });

    const events: SessionEvent[] = [];
    const rosters: SessionMetaView[][] = [];
    manager.on("event", (e) => events.push(e));
    manager.on("roster", (r) => rosters.push(r));
    manager.start();

    // An in-process session (owned) — its events must NOT be tailed from disk.
    const ownSid = manager.dispatch({ prompt: "own work" });

    // A foreign session written by a SECOND store handle, with real events.
    const store2 = new SessionStore({ root });
    const fsid = newSessionId();
    const fmeta = await store2.createSession({
      sid: fsid,
      title: "foreign",
      prompt: "foreign prompt",
      owner: "worker",
      pid: process.pid, // alive → derivedState running → adopted
      cwd,
      mode: "once",
      state: "running",
    });
    const writer = store2.openWriter(fmeta);
    writer.append({
      type: "session.start",
      title: "foreign",
      prompt: "foreign prompt",
      cwd,
      mode: "once",
      owner: "worker",
      pid: process.pid,
    });
    writer.append({ type: "session.state", state: "running" });
    writer.append({
      type: "message",
      role: "user",
      text: "foreign prompt",
      turn: 1,
    });
    await writer.flush();

    // Adoption: the foreign session's events flow onto the merged stream.
    await until(() =>
      events.some((e) => e.sid === fsid && e.type === "message"),
    );
    // Its roster entry appears.
    await until(() => manager!.rosterSnapshot().some((s) => s.sid === fsid));
    // Both sessions are observed by the watcher (so the tail decision has run for each).
    await until(() => manager!.rosterSnapshot().some((s) => s.sid === ownSid));

    // Deterministic tail invariant: foreign IS tailed, own is NEVER tailed.
    const tailedSids = tailSpy.mock.calls.map((c) => c[0]);
    expect(tailedSids).toContain(fsid);
    expect(tailedSids).not.toContain(ownSid);

    // No double-emission for the foreign session's session.start either.
    const foreignStarts = events.filter(
      (e) => e.sid === fsid && e.type === "session.start",
    );
    expect(foreignStarts.length).toBe(1);
    expect(rosters.length).toBeGreaterThan(0);
  });
});

/** Poll until `sid`'s meta exists on disk (createSession is async after dispatch). */
async function pollMetaExists(
  s: InstanceType<typeof SessionStore>,
  sid: string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await s.readMeta(sid)) !== null) return;
    if (Date.now() > deadline)
      throw new Error("meta did not appear before deadline");
    await tick(10);
  }
}
