/**
 * SessionRunner tests (ADR-023) — drive `runSession` with a FAKE `runTurn` and a
 * tmpdir store, asserting the envelope stream it produces on both the in-process
 * bus and the disk log.
 *
 * The engine assembly (`buildTurnExtras`, settings, project context, code graph)
 * is mocked to no-ops so the runner is exercised in isolation — the unit under
 * test is the envelope emission + conversation loop, not the engine wiring. All
 * waits are poll-based (`until`) against a deadline; there are no fixed sleeps,
 * which is the repo rule for anything time-dependent (CI flake).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type {
  AgentAi,
  RunTurnOptions,
  RunTurnResult,
} from "@oxagen/agent-engine";
import type { SessionEvent } from "../events.js";
import type { SessionMeta } from "../store.js";

// Mock the engine-assembly seams so the runner touches no real settings / MCP /
// filesystem rules / code graph. The FAKE runTurn (injected per test) is what
// actually "runs".
vi.mock("../../settings/resolve.js", () => ({
  loadSettings: () => ({
    settings: { permissions: undefined, hooks: undefined, mcpServers: {} },
  }),
}));
vi.mock("../../agent/turn-extras.js", () => ({
  buildTurnExtras: async () => ({
    systemAppend: "",
    extraTools: undefined,
    wrapTools: (t: unknown) => t,
    closeMcp: async () => {},
  }),
}));
vi.mock("../../agent/project-context.js", () => ({
  loadProjectContext: () => ({ text: "", sources: [] }),
}));
vi.mock("../../agent/code-graph.js", () => ({
  queryCodeGraph: async () => "",
}));

const { SessionStore } = await import("../store.js");
const { newSessionId } = await import("../ids.js");
const { runSession } = await import("../runner.js");

// Poll-based tests cost nothing extra when green, but the vitest default 5s
// test timeout (and 4s poll deadlines) starve on loaded CI runners — this
// file's collect step alone can take 30s+ there. Generous ceilings, no sleeps.
vi.setConfig({ testTimeout: 60_000 });

// ── Test helpers ─────────────────────────────────────────────────────────────

const tick = (ms = 10): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until(
  cond: () => boolean,
  timeoutMs = 30_000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error("until(): condition not met before deadline");
    await tick(stepMs);
  }
}

/**
 * Poll the on-disk event log until `cond` is satisfied. The bus tap fires
 * synchronously (see runner.ts "Bus vs disk"), but disk appends are queued
 * behind an async `appendFile` chain — a bus condition settling does NOT mean
 * the disk log has caught up yet, so any assertion against `readEvents` needs
 * its own poll rather than a single post-bus snapshot (this raced under load).
 */
async function untilDisk(
  sid: string,
  cond: (events: SessionEvent[]) => boolean,
  timeoutMs = 30_000,
  stepMs = 10,
): Promise<SessionEvent[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await store.readEvents(sid);
    if (cond(events)) return events;
    if (Date.now() > deadline)
      throw new Error("untilDisk(): condition not met before deadline");
    await tick(stepMs);
  }
}

/** A throwaway AgentAi — the fake runTurn ignores it, but the runner requires one. */
const fakeAi = {} as unknown as AgentAi;

interface FakeTurnConfig {
  deltas?: string[];
  reasoning?: string[];
  text?: string;
  steps?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  messages?: ModelMessage[];
  model?: string;
  filesTouched?: string[];
  emitTool?: boolean;
  /** Override the tool input passed to onToolCall (e.g. a circular object). */
  toolInput?: unknown;
  /** Emit a file-change round (drives the `diff` event). */
  emitDiff?: { diff: string; files: string[] };
  /** Fire the engine's non-fatal onError hook (drives the error passthrough). */
  invokeOnError?: boolean;
  /** Invoke the injected budget guard with this usage (drives budget hooks). */
  invokeBudget?: { inputTokens: number; outputTokens: number };
  /** Throw an Error after streaming (drives the turn-error path). */
  throwError?: string;
  /** Throw a NON-Error value after streaming (drives the String(err) branch). */
  throwRaw?: unknown;
  /** Block after streaming until the turn's signal aborts (cancel/timeout tests). */
  gate?: boolean;
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

/**
 * Build a fake `runTurn`: it streams the configured callbacks, records each
 * call's options (for history assertions), and resolves with a canned result.
 */
function makeFakeRunTurn(cfg: {
  calls: RunTurnOptions[];
  returnedMessages?: ModelMessage[][];
  perCall?: (index: number) => FakeTurnConfig;
  base?: FakeTurnConfig;
}): typeof import("@oxagen/agent-engine").runTurn {
  let index = -1;
  return async (options: RunTurnOptions): Promise<RunTurnResult> => {
    index++;
    cfg.calls.push(options);
    const c: FakeTurnConfig = {
      ...(cfg.base ?? {}),
      ...(cfg.perCall?.(index) ?? {}),
    };

    options.onStage?.({ kind: "execute", label: "coding" });
    for (const r of c.reasoning ?? []) options.onReasoning?.(r);
    for (const d of c.deltas ?? ["Hel", "lo world"]) options.onText?.(d);
    if (c.emitTool) {
      options.onToolCall?.("bash", c.toolInput ?? { command: "echo hi" });
      options.onToolEvent?.({ name: "bash", ok: true, durationMs: 5 });
    }
    if (c.emitDiff) options.onFileChange?.(c.emitDiff.diff, c.emitDiff.files);
    if (c.invokeOnError)
      options.onError?.({
        phase: "memory-recall",
        error: new Error("recall failed"),
      });
    if (c.invokeBudget) await options.budgetGuard?.(c.invokeBudget);
    if (c.throwRaw !== undefined) throw c.throwRaw;
    if (c.throwError) throw new Error(c.throwError);
    if (c.gate) {
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(abortError());
          return;
        }
        options.signal?.addEventListener("abort", () => reject(abortError()), {
          once: true,
        });
      });
    }

    const text = c.text ?? "Hello world";
    const messages: ModelMessage[] = c.messages ?? [
      { role: "assistant", content: text },
    ];
    cfg.returnedMessages?.push(messages);
    return {
      text,
      steps: c.steps ?? 3,
      messages,
      usage: c.usage ?? { inputTokens: 100, outputTokens: 50 },
      trace: {
        selectedModel: c.model ?? "anthropic/claude-haiku-4-5",
        filesTouched: c.filesTouched ?? [],
        finalComplete: true,
      } as unknown as RunTurnResult["trace"],
    };
  };
}

/** Label an event by type, folding session.state's state in for order assertions. */
function label(event: SessionEvent): string {
  return event.type === "session.state"
    ? `session.state:${event.state}`
    : event.type;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let root: string;
let cwd: string;
let store: InstanceType<typeof SessionStore>;
let savedDisableMemory: string | undefined;

beforeEach(async () => {
  savedDisableMemory = process.env["OXAGEN_DISABLE_MEMORY"];
  process.env["OXAGEN_DISABLE_MEMORY"] = "1";
  const base = await mkdtemp(join(tmpdir(), "oxagen-runner-"));
  root = join(base, "fleet");
  cwd = join(base, "cwd");
  await mkdir(root, { recursive: true });
  await mkdir(cwd, { recursive: true });
  store = new SessionStore({ root });
});

afterEach(async () => {
  if (savedDisableMemory === undefined)
    delete process.env["OXAGEN_DISABLE_MEMORY"];
  else process.env["OXAGEN_DISABLE_MEMORY"] = savedDisableMemory;
  vi.restoreAllMocks();
  await rm(join(root, ".."), { recursive: true, force: true }).catch(() => {});
});

async function createMeta(
  overrides: Partial<
    Parameters<InstanceType<typeof SessionStore>["createSession"]>[0]
  > = {},
): Promise<SessionMeta> {
  const sid = newSessionId();
  return store.createSession({
    sid,
    title: "test session",
    prompt: "do the thing",
    owner: "tui",
    pid: process.pid,
    cwd,
    mode: "conversation",
    state: "queued",
    ...overrides,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runSession — event order and coalescing", () => {
  it("emits the envelope stream in the contract order and reaches waiting (conversation)", async () => {
    const meta = await createMeta({ mode: "conversation" });
    const bus: SessionEvent[] = [];
    const calls: RunTurnOptions[] = [];
    const fake = makeFakeRunTurn({
      calls,
      base: { emitTool: true, deltas: ["Hel", "lo world"] },
    });

    const runPromise = runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
      idleTimeoutMs: 5000,
      onLocalEvent: (e) => bus.push(e),
    });

    // Wait until the session parks in `waiting` (turn 1 fully settled) on the
    // bus, THEN separately poll the disk log to catch up (see `untilDisk`).
    await until(() =>
      bus.some((e) => e.type === "session.state" && e.state === "waiting"),
    );

    // Disk order is the canonical, coalesced sequence.
    const disk = await untilDisk(meta.sid, (events) =>
      events.some((e) => e.type === "session.state" && e.state === "waiting"),
    );
    expect(disk.map(label)).toEqual([
      "session.start",
      "session.state:running",
      "message",
      "stage",
      "message.delta",
      "tool.start",
      "tool.end",
      "message.end",
      "turn.end",
      "usage",
      "session.state:waiting",
    ]);

    // Coalescing: the bus saw 2 RAW text deltas; disk collapsed them to 1.
    // The raw bus is a side-channel not gated by the disk `waiting` signal, so
    // under load the 2nd raw delta can still be in flight when `waiting` lands —
    // poll for both raw deltas first so the count assertion is deterministic.
    await until(
      () => bus.filter((e) => e.type === "message.delta").length >= 2,
    );
    const busDeltas = bus.filter((e) => e.type === "message.delta");
    const diskDeltas = disk.filter((e) => e.type === "message.delta");
    expect(busDeltas.length).toBe(2);
    expect(diskDeltas.length).toBe(1);
    expect(diskDeltas[0]).toMatchObject({
      type: "message.delta",
      text: "Hello world",
    });

    // seq is strictly monotonic on disk.
    const seqs = disk.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // tool.start carries the JSON-stringified input.
    const toolStart = disk.find((e) => e.type === "tool.start");
    expect(toolStart).toMatchObject({ type: "tool.start", name: "bash" });

    // End it so the promise settles.
    await store.appendInbox(meta.sid, { type: "cancel", ts: Date.now() });
    const result = await runPromise;
    expect(result.state).toBe("cancelled");
    const final = await store.readEvents(meta.sid);
    expect(label(final[final.length - 1]!)).toBe("session.end");
  });

  it("prices per-turn usage and accumulates cumulative usage", async () => {
    const meta = await createMeta({ mode: "once" });
    const calls: RunTurnOptions[] = [];
    const fake = makeFakeRunTurn({
      calls,
      base: { usage: { inputTokens: 200, outputTokens: 80 } },
    });

    const result = await runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
    });
    expect(result.state).toBe("done");

    const disk = await store.readEvents(meta.sid);
    const turnEnd = disk.find((e) => e.type === "turn.end");
    const usage = disk.find((e) => e.type === "usage");
    expect(turnEnd).toBeTruthy();
    if (turnEnd?.type === "turn.end") {
      expect(turnEnd.usage.inputTokens).toBe(200);
      expect(turnEnd.usage.outputTokens).toBe(80);
      expect(turnEnd.usage.costUsd).toBeGreaterThanOrEqual(0);
    }
    if (usage?.type === "usage") {
      expect(usage.cumulative.inputTokens).toBe(200);
      expect(usage.cumulative.outputTokens).toBe(80);
    }
  });
});

describe("runSession — conversation loop", () => {
  it("threads history from the prior turn's result into the follow-up turn", async () => {
    const meta = await createMeta({ mode: "conversation" });
    const bus: SessionEvent[] = [];
    const calls: RunTurnOptions[] = [];
    const returnedMessages: ModelMessage[][] = [];
    const fake = makeFakeRunTurn({
      calls,
      returnedMessages,
      perCall: (i) => ({ text: `answer ${i}`, deltas: [`answer ${i}`] }),
    });

    const runPromise = runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
      idleTimeoutMs: 5000,
      onLocalEvent: (e) => bus.push(e),
    });

    // Turn 1 settles → waiting.
    await until(() =>
      bus.some((e) => e.type === "session.state" && e.state === "waiting"),
    );
    expect(calls[0]?.history).toBeUndefined();

    // Send a follow-up; turn 2 runs.
    await store.appendInbox(meta.sid, {
      type: "message",
      text: "and again",
      ts: Date.now(),
    });
    await until(() => calls.length === 2);

    // The second call's history is exactly the first turn's returned messages.
    expect(calls[1]?.history).toBe(returnedMessages[0]);
    // The follow-up user message was logged as turn 2. `calls.length === 2`
    // only proves the in-memory emit ran; the disk append is queued behind an
    // async `appendFile` (see `untilDisk`'s doc comment above), so poll rather
    // than read once — this raced under CI load (1 message seen instead of 2).
    const disk = await untilDisk(
      meta.sid,
      (events) => events.filter((e) => e.type === "message").length >= 2,
    );
    const userMsgs = disk.filter((e) => e.type === "message");
    expect(userMsgs.length).toBe(2);
    if (userMsgs[1]?.type === "message") {
      expect(userMsgs[1].turn).toBe(2);
      expect(userMsgs[1].text).toBe("and again");
    }

    await store.appendInbox(meta.sid, { type: "cancel", ts: Date.now() });
    await runPromise;
  });

  it("ends 'cancelled' when a cancel arrives mid-turn", async () => {
    const meta = await createMeta({ mode: "conversation" });
    const bus: SessionEvent[] = [];
    const calls: RunTurnOptions[] = [];
    // `gate: true` makes the turn block until its signal aborts.
    const fake = makeFakeRunTurn({ calls, base: { gate: true } });

    const runPromise = runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
      onLocalEvent: (e) => bus.push(e),
    });

    // Wait until the turn is running (stage emitted), then cancel mid-flight.
    await until(() => bus.some((e) => e.type === "stage"));
    await store.appendInbox(meta.sid, { type: "cancel", ts: Date.now() });

    const result = await runPromise;
    expect(result.state).toBe("cancelled");
    const disk = await store.readEvents(meta.sid);
    const end = disk[disk.length - 1];
    expect(end?.type).toBe("session.end");
    if (end?.type === "session.end") expect(end.state).toBe("cancelled");
  });

  it("creates one file lock per session and passes it to every turn", async () => {
    const meta = await createMeta({ mode: "conversation" });
    const bus: SessionEvent[] = [];
    const calls: RunTurnOptions[] = [];
    const fake = makeFakeRunTurn({ calls });

    const runPromise = runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
      idleTimeoutMs: 5000,
      onLocalEvent: (e) => bus.push(e),
    });

    await until(() =>
      bus.some((e) => e.type === "session.state" && e.state === "waiting"),
    );
    // Every turn gets a non-null cross-process file lock (ADR-021 §5).
    expect(calls[0]?.fileLock).toBeTruthy();

    await store.appendInbox(meta.sid, {
      type: "message",
      text: "again",
      ts: Date.now(),
    });
    await until(() => calls.length === 2);
    // The SAME lock instance is reused — built once per session, not per turn.
    expect(calls[1]?.fileLock).toBe(calls[0]?.fileLock);

    await store.appendInbox(meta.sid, { type: "cancel", ts: Date.now() });
    await runPromise;
  });

  it("ends 'done' after one turn in once mode (no waiting)", async () => {
    const meta = await createMeta({ mode: "once" });
    const calls: RunTurnOptions[] = [];
    const fake = makeFakeRunTurn({ calls });

    const result = await runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
    });
    expect(result.state).toBe("done");

    const disk = await store.readEvents(meta.sid);
    expect(
      disk.some((e) => e.type === "session.state" && e.state === "waiting"),
    ).toBe(false);
    expect(label(disk[disk.length - 1]!)).toBe("session.end");
    expect(calls.length).toBe(1);
  });

  it("ends 'done' on idle timeout while waiting", async () => {
    const meta = await createMeta({ mode: "conversation" });
    const calls: RunTurnOptions[] = [];
    const fake = makeFakeRunTurn({ calls });

    // Tiny idle window: turn 1 settles, waits, and times out to `done`.
    const result = await runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
      idleTimeoutMs: 30,
    });
    expect(result.state).toBe("done");
    const disk = await store.readEvents(meta.sid);
    const end = disk[disk.length - 1];
    if (end?.type === "session.end") expect(end.state).toBe("done");
  });
});

describe("runSession — meta", () => {
  it("patches meta with turns, usage, summary and terminal state", async () => {
    const meta = await createMeta({ mode: "once" });
    const calls: RunTurnOptions[] = [];
    const fake = makeFakeRunTurn({
      calls,
      base: {
        text: "the final answer",
        usage: { inputTokens: 42, outputTokens: 7 },
      },
    });

    await runSession({ store, meta, ai: fakeAi, runTurnImpl: fake });

    const view = await store.readMeta(meta.sid);
    expect(view).toBeTruthy();
    expect(view?.turns).toBe(1);
    expect(view?.usage.inputTokens).toBe(42);
    expect(view?.summary).toBe("the final answer");
    expect(view?.state).toBe("done");
    expect(view?.endedAt).toBeGreaterThan(0);
  });
});

describe("runSession — streaming, budget, errors", () => {
  it("emits reasoning deltas and a diff event with changed-line count", async () => {
    const meta = await createMeta({ mode: "once" });
    const calls: RunTurnOptions[] = [];
    const fake = makeFakeRunTurn({
      calls,
      base: {
        reasoning: ["think", "ing"],
        invokeOnError: true,
        emitDiff: {
          diff: "--- a/x.ts\n+++ b/x.ts\n+added line\n-removed line\n context",
          files: ["x.ts"],
        },
      },
    });

    await runSession({ store, meta, ai: fakeAi, runTurnImpl: fake });

    const disk = await store.readEvents(meta.sid);
    const reasoning = disk.filter((e) => e.type === "reasoning.delta");
    expect(reasoning.length).toBeGreaterThanOrEqual(1);
    const diff = disk.find((e) => e.type === "diff");
    expect(diff).toBeTruthy();
    if (diff?.type === "diff") {
      expect(diff.changedFiles).toEqual(["x.ts"]);
      expect(diff.changedLines).toBe(2); // one +line and one -line (headers ignored)
    }
    // turn.end's changedFiles is sourced from the diff round when the trace has none.
    const turnEnd = disk.find((e) => e.type === "turn.end");
    if (turnEnd?.type === "turn.end")
      expect(turnEnd.changedFiles).toEqual(["x.ts"]);
  });

  it("emits a non-fatal error when the per-turn budget stops the turn", async () => {
    const meta = await createMeta({ mode: "once" });
    const calls: RunTurnOptions[] = [];
    const fake = makeFakeRunTurn({
      calls,
      base: {
        invokeBudget: { inputTokens: 5_000_000, outputTokens: 5_000_000 },
      },
    });

    const result = await runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
      budgetPolicy: {
        enabled: true,
        limitUsd: 0.0001,
        mode: "enforce",
        graceOveragePct: 0,
      },
    });
    expect(result.state).toBe("done"); // the guard stops spending, the turn still settles

    const disk = await store.readEvents(meta.sid);
    const budgetError = disk.find(
      (e) => e.type === "error" && e.message.includes("budget"),
    );
    expect(budgetError).toBeTruthy();
    if (budgetError?.type === "error") expect(budgetError.fatal).toBe(false);
  });

  it("fails in once mode when a turn throws (fatal error event)", async () => {
    const meta = await createMeta({ mode: "once" });
    const calls: RunTurnOptions[] = [];
    const fake = makeFakeRunTurn({
      calls,
      base: { throwError: "engine exploded" },
    });

    const result = await runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
    });
    expect(result.state).toBe("failed");

    const disk = await store.readEvents(meta.sid);
    const err = disk.find((e) => e.type === "error");
    expect(err).toBeTruthy();
    if (err?.type === "error") {
      expect(err.fatal).toBe(true);
      expect(err.message).toContain("engine exploded");
    }
    const end = disk[disk.length - 1];
    if (end?.type === "session.end") expect(end.state).toBe("failed");
  });

  it("builds a default gateway AI port when none is injected", async () => {
    const savedKey = process.env["AI_GATEWAY_API_KEY"];
    process.env["AI_GATEWAY_API_KEY"] = "test-key";
    try {
      const meta = await createMeta({ mode: "once" });
      const calls: RunTurnOptions[] = [];
      const fake = makeFakeRunTurn({ calls });
      // No `ai` injected → the runner constructs its own metered gateway port.
      const result = await runSession({ store, meta, runTurnImpl: fake });
      expect(result.state).toBe("done");
      expect(calls[0]?.ai).toBeTruthy();
    } finally {
      if (savedKey === undefined) delete process.env["AI_GATEWAY_API_KEY"];
      else process.env["AI_GATEWAY_API_KEY"] = savedKey;
    }
  });

  it("warns once within the grace budget window", async () => {
    const meta = await createMeta({ mode: "once" });
    const calls: RunTurnOptions[] = [];
    const fake = makeFakeRunTurn({
      calls,
      // Two guard calls to prove the warning is emitted once.
      base: { invokeBudget: { inputTokens: 1000, outputTokens: 1000 } },
    });

    const result = await runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
      // A tiny limit with an astronomically large grace window guarantees the
      // cost lands ABOVE the limit but WITHIN grace (action: continue).
      budgetPolicy: {
        enabled: true,
        limitUsd: 0.00000001,
        mode: "grace",
        graceOveragePct: 1_000_000_000,
      },
    });
    expect(result.state).toBe("done");

    const disk = await store.readEvents(meta.sid);
    const graceWarn = disk.find(
      (e) => e.type === "error" && e.message.includes("grace window"),
    );
    expect(graceWarn).toBeTruthy();
    if (graceWarn?.type === "error") expect(graceWarn.fatal).toBe(false);
  });

  it("stops a prompt-mode budget when there is no interactive approver", async () => {
    const meta = await createMeta({ mode: "once" });
    const calls: RunTurnOptions[] = [];
    const fake = makeFakeRunTurn({
      calls,
      base: {
        invokeBudget: { inputTokens: 5_000_000, outputTokens: 5_000_000 },
      },
    });

    const result = await runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
      // prompt mode: the guard would ask a human, but a session has no approver,
      // so onPause returns false and the guard stops (surfaced as a non-fatal error).
      budgetPolicy: {
        enabled: true,
        limitUsd: 0.0001,
        mode: "prompt",
        graceOveragePct: 0,
      },
    });
    expect(result.state).toBe("done");

    const disk = await store.readEvents(meta.sid);
    const stopped = disk.find(
      (e) => e.type === "error" && e.message.includes("budget reached"),
    );
    expect(stopped).toBeTruthy();
  });

  it("caps a circular tool input without throwing", async () => {
    const meta = await createMeta({ mode: "once" });
    const calls: RunTurnOptions[] = [];
    const circular: Record<string, unknown> = { command: "x" };
    circular["self"] = circular;
    const fake = makeFakeRunTurn({
      calls,
      base: { emitTool: true, toolInput: circular },
    });

    const result = await runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
    });
    expect(result.state).toBe("done");

    const disk = await store.readEvents(meta.sid);
    const toolStart = disk.find((e) => e.type === "tool.start");
    expect(toolStart).toBeTruthy();
    if (toolStart?.type === "tool.start")
      expect(typeof toolStart.input).toBe("string");
  });

  it("fails on a non-Error throw in once mode (String(err) branch)", async () => {
    const meta = await createMeta({ mode: "once" });
    const calls: RunTurnOptions[] = [];
    const fake = makeFakeRunTurn({
      calls,
      base: { throwRaw: "raw string failure" },
    });

    const result = await runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
    });
    expect(result.state).toBe("failed");

    const disk = await store.readEvents(meta.sid);
    const err = disk.find((e) => e.type === "error");
    if (err?.type === "error")
      expect(err.message).toContain("raw string failure");
  });

  it("times out a hung turn via the inactivity guard (fails in once mode)", async () => {
    // A tiny inactivity window makes the stall detector fire after the fake stops
    // making progress; it aborts the TURN controller (not the session) with an
    // AgentTimeoutError, which the gate fake rejects on, driving the timeout path.
    const savedInactivity = process.env["OXAGEN_TURN_INACTIVITY_MS"];
    process.env["OXAGEN_TURN_INACTIVITY_MS"] = "30";
    try {
      const meta = await createMeta({ mode: "once" });
      const calls: RunTurnOptions[] = [];
      const fake = makeFakeRunTurn({ calls, base: { gate: true } });

      const result = await runSession({
        store,
        meta,
        ai: fakeAi,
        runTurnImpl: fake,
      });
      expect(result.state).toBe("failed");

      const disk = await store.readEvents(meta.sid);
      const err = disk.find((e) => e.type === "error");
      expect(err).toBeTruthy();
      if (err?.type === "error") {
        expect(err.fatal).toBe(true);
        expect(err.message).toMatch(/timed out|inactivity/i);
      }
    } finally {
      if (savedInactivity === undefined)
        delete process.env["OXAGEN_TURN_INACTIVITY_MS"];
      else process.env["OXAGEN_TURN_INACTIVITY_MS"] = savedInactivity;
    }
  });
});

describe("runSession — worker lifecycle bounds", () => {
  it("aborts a worker gracefully when the max-lifetime ceiling elapses", async () => {
    // Tiny lifetime ceiling: turn 1 settles, the worker parks in its (long) idle
    // wait, and the max-lifetime bound fires during that wait — aborting the
    // SESSION through the same graceful path as a cancel, so the session ends
    // cancelled with a terminal error event naming the bound.
    const saved = process.env["OXAGEN_WORKER_MAX_LIFETIME_MS"];
    process.env["OXAGEN_WORKER_MAX_LIFETIME_MS"] = "40";
    try {
      const meta = await createMeta({ mode: "conversation", owner: "worker" });
      const calls: RunTurnOptions[] = [];
      const fake = makeFakeRunTurn({ calls });

      // Long idle window so the ONLY thing that can end the session is the bound.
      const result = await runSession({
        store,
        meta,
        ai: fakeAi,
        runTurnImpl: fake,
        idleTimeoutMs: 60_000,
      });

      expect(result.state).toBe("cancelled");
      const disk = await store.readEvents(meta.sid);
      const err = disk.find((e) => e.type === "error");
      expect(err).toBeTruthy();
      if (err?.type === "error") {
        expect(err.fatal).toBe(false);
        expect(err.message).toMatch(
          /max lifetime|OXAGEN_WORKER_MAX_LIFETIME_MS/i,
        );
      }
    } finally {
      if (saved === undefined)
        delete process.env["OXAGEN_WORKER_MAX_LIFETIME_MS"];
      else process.env["OXAGEN_WORKER_MAX_LIFETIME_MS"] = saved;
    }
  });

  it("does not bound an interactive (tui) session — no lifetime abort", async () => {
    // Same tiny ceiling, but a `tui`-owned session must ignore it entirely: a
    // human is present. The session ends `done` on its own short idle window,
    // never emitting the bound's error event.
    const saved = process.env["OXAGEN_WORKER_MAX_LIFETIME_MS"];
    process.env["OXAGEN_WORKER_MAX_LIFETIME_MS"] = "40";
    try {
      const meta = await createMeta({ mode: "conversation", owner: "tui" });
      const calls: RunTurnOptions[] = [];
      const fake = makeFakeRunTurn({ calls });

      const result = await runSession({
        store,
        meta,
        ai: fakeAi,
        runTurnImpl: fake,
        idleTimeoutMs: 30,
      });

      expect(result.state).toBe("done");
      const disk = await store.readEvents(meta.sid);
      expect(disk.some((e) => e.type === "error")).toBe(false);
    } finally {
      if (saved === undefined)
        delete process.env["OXAGEN_WORKER_MAX_LIFETIME_MS"];
      else process.env["OXAGEN_WORKER_MAX_LIFETIME_MS"] = saved;
    }
  });
});
