/**
 * background-tracker.ts — the REPL's observer for its own detached dispatches.
 *
 * Driven entirely through an injected fake `SessionStore` (the store is already
 * injectable), so these assert the slot accounting, the fold-back notify, the
 * roster filtering, and the orphan backstop without spawning a worker or
 * touching disk.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createBackgroundTracker,
  formatFoldLine,
  type BackgroundRow,
} from "../background-tracker.js";
import type { SessionEvent } from "../../sessions/events.js";
import type { SessionMetaView, SessionStore } from "../../sessions/store.js";

// ── Fake store: capture the tail/roster callbacks so tests can fire them ──────

interface FakeStore {
  store: SessionStore;
  /** Deliver an event to the tail opened for `sid` (no-op if none / stopped). */
  emit(
    sid: string,
    event: Partial<SessionEvent> & Pick<SessionEvent, "type">,
  ): void;
  /** Push a roster snapshot to the single watchSessions subscriber. */
  pushRoster(sessions: SessionMetaView[]): void;
  tailStops: string[];
  rosterStopped: boolean;
}

function makeFakeStore(): FakeStore {
  const tails = new Map<
    string,
    { cb: (e: SessionEvent) => void; stopped: boolean }
  >();
  const state = {
    roster: null as ((s: SessionMetaView[]) => void) | null,
    tailStops: [] as string[],
    rosterStopped: false,
  };
  const store = {
    tailEvents(sid: string, onEvent: (e: SessionEvent) => void) {
      tails.set(sid, { cb: onEvent, stopped: false });
      return {
        stop() {
          const t = tails.get(sid);
          if (t && !t.stopped) {
            t.stopped = true;
            state.tailStops.push(sid);
          }
        },
      };
    },
    watchSessions(onChange: (s: SessionMetaView[]) => void) {
      state.roster = onChange;
      return {
        stop() {
          state.rosterStopped = true;
        },
      };
    },
  } as unknown as SessionStore;

  return {
    store,
    emit(sid, event) {
      const t = tails.get(sid);
      if (!t || t.stopped) return;
      t.cb({ v: 1, sid, seq: 1, ts: Date.now(), ...event } as SessionEvent);
    },
    pushRoster(sessions) {
      state.roster?.(sessions);
    },
    get tailStops() {
      return state.tailStops;
    },
    get rosterStopped() {
      return state.rosterStopped;
    },
  };
}

function metaView(
  over: Partial<SessionMetaView> & Pick<SessionMetaView, "sid">,
): SessionMetaView {
  return {
    v: 1,
    sid: over.sid,
    title: over.title ?? `title-${over.sid}`,
    prompt: "p",
    state: over.state ?? "running",
    owner: "worker",
    pid: 123,
    cwd: "/tmp",
    mode: "conversation",
    createdAt: 1,
    updatedAt: 2,
    turns: over.turns ?? 0,
    lastSeq: 1,
    usage: over.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    alive: over.alive ?? true,
    derivedState: over.derivedState ?? over.state ?? "running",
    ...(over.summary !== undefined ? { summary: over.summary } : {}),
    ...(over.lastActivity !== undefined
      ? { lastActivity: over.lastActivity }
      : {}),
  } as SessionMetaView;
}

describe("formatFoldLine", () => {
  it("renders a done line with short sid, title, summary, files, and cost", () => {
    const line = formatFoldLine({
      sid: "s-abc-7f2q",
      title: "fix the login redirect loop",
      outcome: "done",
      summary: "redirect fixed",
      fileCount: 3,
      costUsd: 0.04,
    });
    expect(line).toBe(
      '◇ 7f2q "fix the login redirect loop" — done: redirect fixed · 3 files · $0.04',
    );
  });

  it("uses ✗ for failed and ◌ for cancelled and omits zero files/cost", () => {
    expect(
      formatFoldLine({
        sid: "s-x-aaaa",
        title: "t",
        outcome: "failed",
        summary: "boom",
        fileCount: 0,
        costUsd: 0,
      }),
    ).toBe('✗ aaaa "t" — failed: boom');
    expect(
      formatFoldLine({
        sid: "s-x-bbbb",
        title: "t",
        outcome: "cancelled",
        summary: "",
        fileCount: 0,
        costUsd: 0,
      }),
    ).toBe('◌ bbbb "t" — cancelled');
  });
});

describe("createBackgroundTracker — slot accounting / cap", () => {
  it("reserve() counts slots up to the cap, then refuses; release frees one", () => {
    const fake = makeFakeStore();
    const tracker = createBackgroundTracker({
      store: fake.store,
      onNotify: () => {},
      onRoster: () => {},
      maxConcurrent: 2,
    });
    expect(tracker.canDispatch()).toBe(true);
    expect(tracker.reserve()).toBe(true);
    expect(tracker.reserve()).toBe(true);
    expect(tracker.runningCount()).toBe(2);
    expect(tracker.canDispatch()).toBe(false);
    expect(tracker.reserve()).toBe(false);
    tracker.release();
    expect(tracker.canDispatch()).toBe(true);
    tracker.dispose();
  });

  it("setMaxConcurrent grows the cap and signals a free slot", () => {
    const fake = makeFakeStore();
    const onSlotFree = vi.fn();
    const tracker = createBackgroundTracker({
      store: fake.store,
      onNotify: () => {},
      onRoster: () => {},
      onSlotFree,
      maxConcurrent: 1,
    });
    tracker.reserve();
    expect(tracker.canDispatch()).toBe(false);
    tracker.setMaxConcurrent(3);
    expect(tracker.canDispatch()).toBe(true);
    expect(onSlotFree).toHaveBeenCalled();
    tracker.dispose();
  });
});

describe("createBackgroundTracker — fold-back on terminal events", () => {
  it("folds a done line on session.end, releasing the slot and signaling free", () => {
    const fake = makeFakeStore();
    const notify = vi.fn();
    const onSlotFree = vi.fn();
    const tracker = createBackgroundTracker({
      store: fake.store,
      onNotify: notify,
      onRoster: () => {},
      onSlotFree,
      maxConcurrent: 2,
    });
    expect(tracker.reserve()).toBe(true);
    tracker.add("s-1-aaaa", "fix the login bug");
    expect(tracker.runningCount()).toBe(1);

    fake.emit("s-1-aaaa", {
      type: "diff",
      changedFiles: ["a.ts", "b.ts"],
      changedLines: 4,
    });
    fake.emit("s-1-aaaa", {
      type: "session.end",
      state: "done",
      summary: "fixed it",
      durationMs: 1000,
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.05 },
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toBe(
      '◇ aaaa "fix the login bug" — done: fixed it · 2 files · $0.05',
    );
    expect(tracker.runningCount()).toBe(0);
    expect(onSlotFree).toHaveBeenCalled();
    // The tail is stopped after the terminal event.
    expect(fake.tailStops).toContain("s-1-aaaa");
    tracker.dispose();
  });

  it("folds a failed line immediately on a fatal error", () => {
    const fake = makeFakeStore();
    const notify = vi.fn();
    const tracker = createBackgroundTracker({
      store: fake.store,
      onNotify: notify,
      onRoster: () => {},
    });
    tracker.reserve();
    tracker.add("s-2-bbbb", "add headers");
    fake.emit("s-2-bbbb", {
      type: "error",
      message: "no api key",
      fatal: true,
    });
    expect(notify.mock.calls[0]?.[0]).toBe(
      '✗ bbbb "add headers" — failed: no api key',
    );
    expect(tracker.runningCount()).toBe(0);
    tracker.dispose();
  });

  it("notifies exactly once even if session.end and roster both report terminal", () => {
    const fake = makeFakeStore();
    const notify = vi.fn();
    const tracker = createBackgroundTracker({
      store: fake.store,
      onNotify: notify,
      onRoster: () => {},
    });
    tracker.reserve();
    tracker.add("s-3-cccc", "t");
    fake.emit("s-3-cccc", {
      type: "session.end",
      state: "done",
      summary: "ok",
      durationMs: 1,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    fake.pushRoster([
      metaView({ sid: "s-3-cccc", derivedState: "done", summary: "ok" }),
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });
});

describe("createBackgroundTracker — roster", () => {
  it("publishes only tracked sids as rows", () => {
    const fake = makeFakeStore();
    const rosters: BackgroundRow[][] = [];
    const tracker = createBackgroundTracker({
      store: fake.store,
      onNotify: () => {},
      onRoster: (rows) => rosters.push(rows),
    });
    tracker.reserve();
    tracker.add("s-mine-dddd", "my task");
    fake.pushRoster([
      metaView({
        sid: "s-mine-dddd",
        title: "my task",
        derivedState: "running",
        lastActivity: "wrote a.ts",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.02 },
      }),
      metaView({
        sid: "s-stranger-eeee",
        title: "not mine",
        derivedState: "running",
      }),
    ]);
    const last = rosters.at(-1)!;
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({
      sid: "s-mine-dddd",
      title: "my task",
      state: "running",
      detail: "wrote a.ts",
      costUsd: 0.02,
    });
    tracker.dispose();
  });

  it("releases the slot for an orphaned worker that never wrote session.end", () => {
    const fake = makeFakeStore();
    const notify = vi.fn();
    const onSlotFree = vi.fn();
    const tracker = createBackgroundTracker({
      store: fake.store,
      onNotify: notify,
      onRoster: () => {},
      onSlotFree,
    });
    tracker.reserve();
    tracker.add("s-4-ffff", "doomed");
    expect(tracker.runningCount()).toBe(1);
    // No session.end ever arrives — the worker's pid is dead → derives orphaned.
    fake.pushRoster([metaView({ sid: "s-4-ffff", derivedState: "orphaned" })]);
    expect(tracker.runningCount()).toBe(0);
    expect(notify.mock.calls[0]?.[0]).toContain('✗ ffff "doomed" — failed');
    expect(onSlotFree).toHaveBeenCalled();
    tracker.dispose();
  });
});

describe("createBackgroundTracker — dispose", () => {
  it("stops the roster watch and every open tail", () => {
    const fake = makeFakeStore();
    const tracker = createBackgroundTracker({
      store: fake.store,
      onNotify: () => {},
      onRoster: () => {},
    });
    tracker.reserve();
    tracker.add("s-5-gggg", "t");
    tracker.dispose();
    expect(fake.rosterStopped).toBe(true);
    expect(fake.tailStops).toContain("s-5-gggg");
    // After dispose, reserve is a no-op.
    expect(tracker.reserve()).toBe(false);
  });
});
