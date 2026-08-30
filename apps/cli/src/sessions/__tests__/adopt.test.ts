/**
 * Orphan auto-resume — proves adoptOrphans forks dead sessions back to life,
 * stays idempotent across restarts (never double-forks), honours the resume
 * budget, and never lets one failed resume abort the batch. Uses a real
 * tmpdir-backed SessionStore, so the on-disk orphan derivation + resumeOf
 * provenance are the actual signals under test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptOrphans } from "../adopt.js";
import { newSessionId } from "../ids.js";
import { SessionStore, type SessionMeta } from "../store.js";

let root: string;
let store: SessionStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oxa-adopt-"));
  store = new SessionStore({ root });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A session whose owner pid is dead and state non-terminal → derives orphaned. */
async function makeOrphan(): Promise<SessionMeta> {
  const sid = newSessionId();
  const meta = await store.createSession({
    sid,
    title: "orphan",
    prompt: "do the thing",
    owner: "worker",
    pid: process.pid,
    cwd: root,
    mode: "conversation",
    state: "running",
  });
  const writer = store.openWriter(meta);
  writer.patchMeta({ pid: 999_999_999, state: "running" }); // certainly-dead pid
  await writer.flush();
  return meta;
}

/** A live, terminal or active session that must never be adopted. */
async function makeLive(state: SessionMeta["state"]): Promise<SessionMeta> {
  return store.createSession({
    sid: newSessionId(),
    title: "live",
    prompt: "alive",
    owner: "tui",
    pid: process.pid, // our own, alive
    cwd: root,
    mode: "conversation",
    state,
  });
}

/** A resume fn that actually forks (records resumeOf), so idempotency is real. */
function resumerVia(target: SessionStore): (sid: string) => Promise<string> {
  return async (sid: string) => {
    const child = await target.createSession({
      sid: newSessionId(),
      title: "resumed",
      prompt: `resume of ${sid}`,
      owner: "worker",
      pid: process.pid,
      cwd: root,
      mode: "conversation",
      state: "running",
      resumeOf: { sid, turn: 0 },
    });
    return child.sid;
  };
}

describe("adoptOrphans", () => {
  it("resumes each orphan and records provenance", async () => {
    const o1 = await makeOrphan();
    const o2 = await makeOrphan();
    await makeLive("done"); // ignored

    const res = await adoptOrphans({
      cwd: root,
      store,
      resume: resumerVia(store),
    });

    expect(res.adopted.map((a) => a.sid).sort()).toEqual(
      [o1.sid, o2.sid].sort(),
    );
    expect(res.adopted.every((a) => a.newSid && a.newSid !== a.sid)).toBe(true);
    expect(res.skipped).toEqual([]);
  });

  it("is idempotent — a second run never re-forks an already-adopted orphan", async () => {
    const o1 = await makeOrphan();
    const first = await adoptOrphans({
      cwd: root,
      store,
      resume: resumerVia(store),
    });
    expect(first.adopted).toHaveLength(1);

    const second = await adoptOrphans({
      cwd: root,
      store,
      resume: resumerVia(store),
    });
    expect(second.adopted).toEqual([]);
    expect(second.skipped).toContain(o1.sid);
  });

  it("caps resume calls at the limit; excess eligible orphans are skipped", async () => {
    for (let i = 0; i < 5; i++) await makeOrphan();
    let calls = 0;
    const resume = async (sid: string): Promise<string> => {
      calls++;
      return resumerVia(store)(sid);
    };

    const res = await adoptOrphans({ cwd: root, store, resume, limit: 2 });
    expect(res.adopted).toHaveLength(2);
    expect(res.skipped).toHaveLength(3);
    expect(calls).toBe(2);
  });

  it("records a failed resume as skipped and keeps going", async () => {
    const bad = await makeOrphan();
    await makeOrphan();
    const resume = async (sid: string): Promise<string> => {
      if (sid === bad.sid) throw new Error("restore failed");
      return resumerVia(store)(sid);
    };

    const res = await adoptOrphans({ cwd: root, store, resume });
    expect(res.skipped).toContain(bad.sid);
    expect(res.adopted).toHaveLength(1); // the other orphan still adopted
  });

  it("adopts the orphaned tip of a resume chain, skipping the source behind it", async () => {
    // O was resumed into C, but C's worker also died → C is the adoptable tip;
    // O stays skipped behind its existing child.
    const o = await makeOrphan();
    const child = await store.createSession({
      sid: newSessionId(),
      title: "resumed-but-died",
      prompt: `resume of ${o.sid}`,
      owner: "worker",
      pid: process.pid,
      cwd: root,
      mode: "conversation",
      state: "running",
      resumeOf: { sid: o.sid, turn: 0 },
    });
    // Kill the child's owner so it derives orphaned too.
    const w = store.openWriter(child);
    w.patchMeta({ pid: 999_999_999 });
    await w.flush();

    const res = await adoptOrphans({
      cwd: root,
      store,
      resume: resumerVia(store),
    });
    expect(res.adopted.map((a) => a.sid)).toEqual([child.sid]);
    expect(res.skipped).toContain(o.sid);
  });

  it("returns empty when there are no orphans", async () => {
    await makeLive("running");
    await makeLive("done");
    const res = await adoptOrphans({
      cwd: root,
      store,
      resume: resumerVia(store),
    });
    expect(res).toEqual({ adopted: [], skipped: [] });
  });

  it("adopts nothing when the limit is 0", async () => {
    const o = await makeOrphan();
    const res = await adoptOrphans({
      cwd: root,
      store,
      resume: resumerVia(store),
      limit: 0,
    });
    expect(res.adopted).toEqual([]);
    expect(res.skipped).toEqual([o.sid]);
  });

  it("defaults the store to the fleet store for cwd (no orphans in a fresh project)", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "oxa-adopt-fresh-"));
    try {
      const res = await adoptOrphans({ cwd: fresh, resume: resumerVia(store) });
      expect(res).toEqual({ adopted: [], skipped: [] });
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
