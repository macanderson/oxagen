/**
 * Session store tests (ADR-023) — the on-disk append-only event logs that make
 * cross-process fleet aggregation work.
 *
 * Every test gets a fresh tmpdir root (no shared state) and waits with a
 * poll-based `until()` — never a fixed sleep, so the suite is fast and
 * CI-stable. Coverage: create/meta shape, writer seq monotonicity + ordering
 * under load, meta.json atomicity observed from the reader side, event/inbox
 * tailing (replay + live + fromSeq + stop + junk-skipping), roster watch,
 * dead-owner orphan derivation, and age/active-aware clean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSessionId } from "../ids.js";
import { sessionDir } from "../paths.js";
import {
  SessionStore,
  isActiveState,
  sessionMetaSchema,
  type CreateSessionInit,
  type InboxMessage,
  type SessionMeta,
  type SessionMetaView,
  type TailHandle,
} from "../store.js";

const tick = (ms = 10): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until(
  cond: () => boolean,
  timeoutMs = 4000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() - deadline > 0)
      throw new Error("until(): condition not met before deadline");
    await tick(stepMs);
  }
}

let root: string;
let store: SessionStore;
const handles: TailHandle[] = [];

/** Register a tail/watch handle so afterEach always tears it down. */
function track<T extends TailHandle>(handle: T): T {
  handles.push(handle);
  return handle;
}

/** Create a session with sane defaults; overrides win. */
function makeSession(
  overrides: Partial<CreateSessionInit> = {},
): Promise<SessionMeta> {
  const init: CreateSessionInit = {
    sid: newSessionId(),
    title: "test session",
    prompt: "do the thing",
    owner: "tui",
    pid: process.pid,
    cwd: root,
    mode: "conversation",
  };
  return store.createSession({ ...init, ...overrides });
}

const metaPath = (sid: string): string =>
  join(sessionDir(root, sid), "meta.json");
const eventsPath = (sid: string): string =>
  join(sessionDir(root, sid), "events.ndjson");
const inboxPath = (sid: string): string =>
  join(sessionDir(root, sid), "inbox.ndjson");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oxa-fleet-store-"));
  store = new SessionStore({ root });
});

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.stop();
  await rm(root, { recursive: true, force: true });
});

describe("createSession", () => {
  it("writes schema-valid meta, empty log + inbox, and reads back alive+queued", async () => {
    const sid = newSessionId();
    const meta = await makeSession({ sid });
    expect(meta.state).toBe("queued");

    // meta.json is a complete, schema-valid document.
    const raw = await readFile(metaPath(sid), "utf8");
    const parsed = sessionMetaSchema.parse(JSON.parse(raw));
    expect(parsed.sid).toBe(sid);

    // Log + inbox exist and are empty.
    expect(await readFile(eventsPath(sid), "utf8")).toBe("");
    expect(await readFile(inboxPath(sid), "utf8")).toBe("");

    // The read-time view derives liveness from our own (alive) pid.
    const view = await store.readMeta(sid);
    if (!view) throw new Error("readMeta returned null");
    expect(view.alive).toBe(true);
    expect(view.derivedState).toBe("queued");
  });

  it("round-trips resumeOf fork provenance (ADR-028) — and stays absent when omitted", async () => {
    const sid = newSessionId();
    const meta = await makeSession({
      sid,
      resumeOf: { sid: "s-source-abcd", turn: 3 },
    });
    expect(meta.resumeOf).toEqual({ sid: "s-source-abcd", turn: 3 });

    // On-disk meta parses back with the same provenance.
    const parsed = sessionMetaSchema.parse(
      JSON.parse(await readFile(metaPath(sid), "utf8")),
    );
    expect(parsed.resumeOf).toEqual({ sid: "s-source-abcd", turn: 3 });
    const view = await store.readMeta(sid);
    expect(view?.resumeOf).toEqual({ sid: "s-source-abcd", turn: 3 });

    // Additive: a plain session has no resumeOf key at all (pre-ADR-028 shape).
    const plainSid = newSessionId();
    await makeSession({ sid: plainSid });
    const plain = JSON.parse(
      await readFile(metaPath(plainSid), "utf8"),
    ) as Record<string, unknown>;
    expect("resumeOf" in plain).toBe(false);
    expect(sessionMetaSchema.parse(plain).resumeOf).toBeUndefined();
  });
});

describe("openWriter", () => {
  it("stamps monotonic seq; readEvents honors order, fromSeq, and lastSeq", async () => {
    const sid = newSessionId();
    const meta = await makeSession({ sid });
    const writer = store.openWriter(meta);

    const e1 = writer.append({ type: "message.delta", text: "a", turn: 1 });
    const e2 = writer.append({ type: "message.delta", text: "b", turn: 1 });
    const e3 = writer.append({ type: "message.delta", text: "c", turn: 1 });
    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);
    await writer.flush();

    expect((await store.readEvents(sid)).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(
      (await store.readEvents(sid, { fromSeq: 3 })).map((e) => e.seq),
    ).toEqual([3]);

    const view = await store.readMeta(sid);
    if (!view) throw new Error("readMeta returned null");
    expect(view.lastSeq).toBe(3);
  });

  it("preserves seq order on disk under a 200-event burst", async () => {
    const sid = newSessionId();
    const meta = await makeSession({ sid });
    const writer = store.openWriter(meta);
    for (let i = 0; i < 200; i++)
      writer.append({ type: "message.delta", text: `x${i}`, turn: 1 });
    await writer.flush();

    const raw = await readFile(eventsPath(sid), "utf8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(200);
    const seqs = lines.map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(seqs).toEqual(Array.from({ length: 200 }, (_unused, i) => i + 1));
  });

  it("patchMeta merges fields and bumps updatedAt", async () => {
    const sid = newSessionId();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const meta = await makeSession({ sid });
    expect(meta.updatedAt).toBe(1_000);

    const writer = store.openWriter(meta);
    nowSpy.mockReturnValue(5_000);
    writer.patchMeta({ title: "renamed", turns: 2 });
    await writer.flush();
    nowSpy.mockRestore();

    const view = await store.readMeta(sid);
    if (!view) throw new Error("readMeta returned null");
    expect(view.title).toBe("renamed"); // patched
    expect(view.turns).toBe(2); // patched
    expect(view.prompt).toBe(meta.prompt); // untouched field preserved (merge)
    expect(view.updatedAt).toBe(5_000); // bumped
  });

  it("keeps meta.json a complete JSON document while events stream (tmp+rename atomicity)", async () => {
    const sid = newSessionId();
    const meta = await makeSession({ sid });
    const writer = store.openWriter(meta);

    // A reader loop racing the writer: every read must yield parseable JSON —
    // the tmp+rename in writeMetaAtomic guarantees no torn document is ever seen.
    let stop = false;
    let parseError: unknown = null;
    const reader = (async () => {
      while (!stop) {
        let raw: string;
        try {
          raw = await readFile(metaPath(sid), "utf8");
        } catch {
          await tick(1);
          continue; // a momentary ENOENT during rename is fine; retry
        }
        try {
          JSON.parse(raw);
        } catch (err) {
          parseError = err;
          return;
        }
        await tick(1);
      }
    })();

    for (let i = 0; i < 200; i++) {
      writer.append({ type: "message.delta", text: `y${i}`, turn: 1 });
      if (i % 5 === 0) await tick(0); // yield so meta writes interleave with reads
    }
    await writer.flush();
    stop = true;
    await reader;

    expect(parseError).toBeNull();
    const view = await store.readMeta(sid);
    if (!view) throw new Error("readMeta returned null");
    expect(view.lastSeq).toBe(200);
  });
});

describe("tailEvents", () => {
  it("replays existing events then streams new ones", async () => {
    const sid = newSessionId();
    const meta = await makeSession({ sid });
    const writer = store.openWriter(meta);
    writer.append({ type: "message.delta", text: "1", turn: 1 });
    writer.append({ type: "message.delta", text: "2", turn: 1 });
    await writer.flush();

    const seen: number[] = [];
    track(store.tailEvents(sid, (e) => seen.push(e.seq), { intervalMs: 20 }));
    await until(() => seen.length >= 2);
    expect(seen).toEqual([1, 2]); // events appended BEFORE the tail are replayed

    writer.append({ type: "message.delta", text: "3", turn: 1 });
    await writer.flush();
    await until(() => seen.length >= 3);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("honors fromSeq", async () => {
    const sid = newSessionId();
    const meta = await makeSession({ sid });
    const writer = store.openWriter(meta);
    for (let i = 0; i < 3; i++)
      writer.append({ type: "message.delta", text: `${i}`, turn: 1 });
    await writer.flush();

    const seen: number[] = [];
    track(
      store.tailEvents(sid, (e) => seen.push(e.seq), {
        fromSeq: 2,
        intervalMs: 20,
      }),
    );
    await until(() => seen.length >= 2);
    expect(seen).toEqual([2, 3]); // seq 1 filtered out
  });

  it("stop() halts further delivery", async () => {
    const sid = newSessionId();
    const meta = await makeSession({ sid });
    const writer = store.openWriter(meta);
    writer.append({ type: "message.delta", text: "1", turn: 1 });
    await writer.flush();

    const seen: number[] = [];
    const handle = track(
      store.tailEvents(sid, (e) => seen.push(e.seq), { intervalMs: 20 }),
    );
    await until(() => seen.includes(1));
    handle.stop();
    const countAtStop = seen.length;

    writer.append({ type: "message.delta", text: "2", turn: 1 });
    await writer.flush();

    // A fresh tail proves the new event reached disk AND that enough poll
    // cycles elapsed that the stopped tail would have fired had it been live.
    const seen2: number[] = [];
    track(store.tailEvents(sid, (e) => seen2.push(e.seq), { intervalMs: 20 }));
    await until(() => seen2.includes(2));
    expect(seen.length).toBe(countAtStop); // stopped tail never advanced
  });
});

describe("inbox", () => {
  it("appendInbox + tailInbox round-trip, skipping junk lines", async () => {
    const sid = newSessionId();
    await makeSession({ sid });

    await store.appendInbox(sid, { type: "message", text: "hi", ts: 1 });
    await appendFile(inboxPath(sid), "this is not json\n"); // non-JSON junk
    await appendFile(inboxPath(sid), JSON.stringify({ type: "bogus" }) + "\n"); // valid JSON, wrong shape
    await store.appendInbox(sid, { type: "cancel", ts: 2 });

    const seen: InboxMessage[] = [];
    track(store.tailInbox(sid, (m) => seen.push(m), { intervalMs: 20 }));
    await until(() => seen.length >= 2);
    expect(seen).toEqual([
      { type: "message", text: "hi", ts: 1 },
      { type: "cancel", ts: 2 },
    ]);
  });
});

describe("watchSessions", () => {
  it("emits the roster and fires again when a session is added", async () => {
    const a = newSessionId();
    await makeSession({ sid: a });

    let last: SessionMetaView[] = [];
    track(
      store.watchSessions(
        (sessions) => {
          last = sessions;
        },
        { intervalMs: 30 },
      ),
    );
    await until(() => last.length === 1);

    const b = newSessionId();
    await makeSession({ sid: b });
    await until(() => last.length === 2);
    expect(last.map((s) => s.sid).sort()).toEqual([a, b].sort());
  });
});

describe("orphan derivation", () => {
  it("derives orphaned for a dead owner in a non-terminal state", async () => {
    const sid = newSessionId();
    const meta = await makeSession({ sid, state: "running" });
    // Point meta at a pid that is certainly dead, keeping a non-terminal state.
    const writer = store.openWriter(meta);
    writer.patchMeta({ pid: 999_999_999, state: "running" });
    await writer.flush();

    const view = await store.readMeta(sid);
    if (!view) throw new Error("readMeta returned null");
    expect(view.alive).toBe(false);
    expect(view.derivedState).toBe("orphaned");
  });

  it("isActiveState is true only for queued/running/waiting", () => {
    expect(isActiveState("queued")).toBe(true);
    expect(isActiveState("running")).toBe(true);
    expect(isActiveState("waiting")).toBe(true);
    expect(isActiveState("done")).toBe(false);
    expect(isActiveState("failed")).toBe(false);
    expect(isActiveState("cancelled")).toBe(false);
    expect(isActiveState("orphaned")).toBe(false);
  });
});

describe("clean", () => {
  it("removes an old terminal session but keeps an active one", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;

    // A terminal session whose last activity is ten days old.
    const oldSid = newSessionId();
    nowSpy.mockReturnValue(tenDaysAgo);
    const oldMeta = await makeSession({ sid: oldSid });
    const oldWriter = store.openWriter(oldMeta);
    oldWriter.patchMeta({ state: "done" });
    await oldWriter.flush();
    nowSpy.mockRestore();

    // An active session with our own (alive) pid, updated just now.
    const liveSid = newSessionId();
    await makeSession({ sid: liveSid, state: "running" });

    const res = await store.clean(); // default: older than 7d
    expect(res.removed).toEqual([oldSid]);
    expect(await store.readMeta(oldSid)).toBeNull();
    const live = await store.readMeta(liveSid);
    if (!live) throw new Error("active session was removed");
    expect(live.derivedState).toBe("running");
  });

  it("with { all: true } removes recent terminal sessions but never an active one", async () => {
    const doneSid = newSessionId();
    const doneMeta = await makeSession({ sid: doneSid });
    const doneWriter = store.openWriter(doneMeta);
    doneWriter.patchMeta({ state: "done" }); // terminal, but updated just now
    await doneWriter.flush();

    const liveSid = newSessionId();
    await makeSession({ sid: liveSid, state: "running" }); // active, alive pid

    const res = await store.clean({ all: true });
    expect(res.removed).toEqual([doneSid]);
    expect(await store.readMeta(doneSid)).toBeNull();
    expect(await store.readMeta(liveSid)).not.toBeNull();
  });
});
