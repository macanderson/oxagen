/**
 * Ink tests for Mission Control's root component: composer dispatch (never
 * blocked), @sid routing, mode switching on an empty composer, event → timeline
 * rendering, cancel arming, and ctrl-c drain. The manager is a plain
 * EventEmitter fake satisfying the structural ManagerHandle — no casts — and
 * the store is a real SessionStore on a tmpdir (the focus pane replays it).
 * Poll-with-deadline throughout; never fixed sleeps.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MissionControlApp,
  type ManagerHandle,
} from "../mission-control-app.js";
import { SessionStore, type SessionMetaView } from "../../../sessions/store.js";
import type { SessionEvent } from "../../../sessions/events.js";

async function until(
  cond: () => boolean,
  timeoutMs = 3000,
  frame?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      const tail = frame ? `\n--- last frame ---\n${frame()}` : "";
      throw new Error(`until(): condition not met in time${tail}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const metaView = (
  sid: string,
  over: Partial<SessionMetaView> = {},
): SessionMetaView =>
  ({
    v: 1,
    sid,
    title: `task ${sid}`,
    prompt: "p",
    state: "running",
    owner: "tui",
    pid: process.pid,
    cwd: "/proj",
    mode: "conversation",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turns: 0,
    lastSeq: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    alive: true,
    derivedState: "running",
    ...over,
  }) as SessionMetaView;

class FakeManager extends EventEmitter implements ManagerHandle {
  dispatched: Array<{ prompt: string }> = [];
  sent: Array<{ sid: string; text: string }> = [];
  cancelled: string[] = [];
  drained = 0;
  private roster: SessionMetaView[] = [];
  private counter = 0;

  rosterSnapshot(): SessionMetaView[] {
    return this.roster;
  }

  dispatch(opts: { prompt: string }): string {
    this.dispatched.push({ prompt: opts.prompt });
    this.counter += 1;
    const sid = `s-test-${String(this.counter).padStart(4, "0")}`;
    this.roster = [...this.roster, metaView(sid, { title: opts.prompt })];
    queueMicrotask(() => this.emit("roster", this.roster));
    return sid;
  }

  async send(sid: string, text: string): Promise<void> {
    this.sent.push({ sid, text });
  }

  async cancel(sid: string): Promise<void> {
    this.cancelled.push(sid);
  }

  async drain(): Promise<void> {
    this.drained += 1;
  }

  seedRoster(sessions: SessionMetaView[]): void {
    this.roster = sessions;
    this.emit("roster", sessions);
  }

  emitEvent(e: SessionEvent): void {
    this.emit("event", e);
  }
}

let root: string;
let store: SessionStore;
let manager: FakeManager;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oxagen-mc-"));
  store = new SessionStore({ root });
  manager = new FakeManager();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const mount = (focusSid?: string) =>
  render(
    <MissionControlApp
      store={store}
      manager={manager}
      cwd="/Users/dev/proj"
      {...(focusSid !== undefined ? { focusSid } : {})}
    />,
  );

const ev = (sid: string, seq: number, partial: object): SessionEvent =>
  ({ v: 1, sid, seq, ts: Date.now(), ...partial }) as SessionEvent;

describe("MissionControlApp", () => {
  it("shows the empty-state invitation before any session exists", async () => {
    const { lastFrame, unmount } = mount();
    await until(() =>
      (lastFrame() ?? "").includes("every line becomes an agent"),
    );
    unmount();
  });

  it("typing + enter dispatches immediately and the rail row appears", async () => {
    const { stdin, lastFrame, unmount } = mount();
    await until(() => (lastFrame() ?? "").length > 0);
    stdin.write("fix the login bug");
    await until(() => (lastFrame() ?? "").includes("fix the login bug"));
    stdin.write("\r");
    await until(() => manager.dispatched.length === 1);
    expect(manager.dispatched[0]?.prompt).toBe("fix the login bug");
    // The dispatch notice lands in the timeline and the roster paints the rail.
    await until(() => (lastFrame() ?? "").includes("◇ dispatched"));
    await until(
      () =>
        (lastFrame() ?? "").includes("task") ||
        (lastFrame() ?? "").includes("0001"),
    );
    unmount();
  });

  it("@sid message routes to send, not to a new session", async () => {
    manager.seedRoster([metaView("s-test-7f2q")]);
    const { stdin, lastFrame, unmount } = mount();
    await until(() => manager.rosterSnapshot().length === 1);
    stdin.write("@7f2q add more tests");
    // Wait for the composer to commit the text before Enter — back-to-back
    // writes would let the return handler read a not-yet-rendered buffer.
    await until(
      () => (lastFrame() ?? "").includes("@7f2q add more tests"),
      3000,
      () => lastFrame() ?? "",
    );
    stdin.write("\r");
    await until(
      () => manager.sent.length === 1,
      3000,
      () => lastFrame() ?? "",
    );
    expect(manager.sent[0]).toEqual({
      sid: "s-test-7f2q",
      text: "add more tests",
    });
    expect(manager.dispatched).toHaveLength(0);
    unmount();
  });

  it("bus events render as aggregate lines", async () => {
    manager.seedRoster([metaView("s-test-aaaa")]);
    const { lastFrame, unmount } = mount();
    manager.emitEvent(
      ev("s-test-aaaa", 1, {
        type: "message.end",
        text: "Deployed the fix.",
        turn: 1,
      }),
    );
    await until(() => (lastFrame() ?? "").includes("Deployed the fix."));
    manager.emitEvent(
      ev("s-test-aaaa", 2, {
        type: "tool.end",
        name: "bash",
        ok: false,
        durationMs: 100,
      }),
    );
    await until(() => (lastFrame() ?? "").includes("bash failed"));
    unmount();
  });

  it("empty-composer letters switch modes; typed letters go to the composer", async () => {
    manager.seedRoster([metaView("s-test-bbbb")]);
    const { stdin, lastFrame, unmount } = mount();
    await until(() => (lastFrame() ?? "").includes("ggregate"));
    stdin.write("r");
    await until(() => (lastFrame() ?? "").match(/\[r\]oster/) !== null);
    stdin.write("a");
    await until(() => (lastFrame() ?? "").includes("[a]ggregate"));
    // With text in the buffer, 'r' is INPUT, not a mode switch.
    stdin.write("run r");
    await until(() => (lastFrame() ?? "").includes("run r"));
    unmount();
  });

  it("focus mode: enter sends a follow-up to the selected session", async () => {
    manager.seedRoster([metaView("s-test-cccc")]);
    const { stdin, lastFrame, unmount } = mount("s-test-cccc");
    await until(
      () => (lastFrame() ?? "").includes("reply to cccc"),
      3000,
      () => lastFrame() ?? "",
    );
    stdin.write("also update the docs");
    await until(() => (lastFrame() ?? "").includes("also update the docs"));
    stdin.write("\r");
    await until(
      () => manager.sent.length === 1,
      3000,
      () => lastFrame() ?? "",
    );
    expect(manager.sent[0]).toEqual({
      sid: "s-test-cccc",
      text: "also update the docs",
    });
    unmount();
  });

  it("cancel is a two-press latch on the selected session", async () => {
    manager.seedRoster([metaView("s-test-dddd")]);
    const { stdin, lastFrame, unmount } = mount();
    // Wait for the rail to PAINT (not just the fake's snapshot) so Ink has
    // mounted its stdin listener — a keystroke before that is dropped.
    await until(
      () => (lastFrame() ?? "").includes("dddd"),
      3000,
      () => lastFrame() ?? "",
    );
    stdin.write("c");
    await until(
      () => (lastFrame() ?? "").includes("press c again"),
      3000,
      () => lastFrame() ?? "",
    );
    expect(manager.cancelled).toHaveLength(0);
    stdin.write("c");
    await until(() => manager.cancelled.length === 1);
    expect(manager.cancelled[0]).toBe("s-test-dddd");
    unmount();
  });

  it("ctrl-c drains owned sessions before exit", async () => {
    manager.seedRoster([metaView("s-test-eeee")]);
    const { stdin, unmount } = mount();
    await until(() => manager.rosterSnapshot().length === 1);
    stdin.write("\x03");
    await until(() => manager.drained === 1);
    unmount();
  });
});
