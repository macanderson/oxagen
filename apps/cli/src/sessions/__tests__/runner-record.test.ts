/**
 * SessionRunner × ADR-028 recording tests — drive `runSession` with a FAKE
 * `runTurn` against a tmpdir store and assert the sidecar record it produces:
 * default-on recording (run.meta / turn.start / turn.end / fs.layer), full tool
 * I/O captured through the composed `wrapTools`, auto-distillation of failed
 * runs, the `OXAGEN_FLEET_RECORD=0` kill switch, and `resumeOf` history
 * seeding. Engine-assembly seams are mocked exactly like runner.test.ts —
 * the unit under test is the recorder wiring, not the engine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage, ToolSet } from "ai";
import type {
  AgentAi,
  RunTurnOptions,
  RunTurnResult,
} from "@oxagen/agent-engine";
import { openRecordStore, type ReplayRecord } from "@oxagen/replay";
import type { SessionMeta } from "../store.js";

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
const { sessionDir } = await import("../paths.js");
const { runSession } = await import("../runner.js");

// Same ceiling rationale as runner.test.ts: generous deadlines, zero sleeps.
vi.setConfig({ testTimeout: 60_000 });

const tick = (ms = 10): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until(
  cond: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline)
      throw new Error("until(): condition not met before deadline");
    await tick(10);
  }
}

/** A throwaway AgentAi — the fake runTurn ignores it, but the runner requires one. */
const fakeAi = {} as unknown as AgentAi;

interface FakeTurnConfig {
  text?: string;
  messages?: ModelMessage[];
  /** Invoke the (recorder-)wrapped tool set the runner composed. */
  invokeWrappedTool?: boolean;
  /** Throw an Error after streaming (drives the failed-session path). */
  throwError?: string;
}

/** Build a fake `runTurn` that exercises the wrapTools seam and settles. */
function makeFakeRunTurn(cfg: {
  calls: RunTurnOptions[];
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

    options.onText?.("Hello");
    if (c.invokeWrappedTool) {
      // The engine applies wrapTools to its tool set; do the same here so the
      // recorder's outermost wrapper sees a real execution.
      const rawTools = {
        echo: {
          description: "echo the input back",
          execute: async (input: unknown) => ({ echoed: input }),
        },
      } as unknown as ToolSet;
      const tools = options.wrapTools ? options.wrapTools(rawTools) : rawTools;
      const echo = tools["echo"];
      if (!echo?.execute) throw new Error("wrapped tool lost its execute");
      // Loose call shape (like the engine's dispatcher) — the AI SDK's
      // ToolExecutionOptions carries fields irrelevant to this seam.
      const exec = echo.execute as unknown as (
        input: unknown,
        options: unknown,
      ) => Promise<unknown>;
      await exec({ value: 42 }, { toolCallId: "call-1", messages: [] });
    }
    if (c.throwError) throw new Error(c.throwError);

    const text = c.text ?? "Hello world";
    const messages: ModelMessage[] = c.messages ?? [
      { role: "assistant", content: text },
    ];
    return {
      text,
      steps: 2,
      messages,
      usage: { inputTokens: 100, outputTokens: 50 },
      trace: {
        selectedModel: "anthropic/claude-haiku-4-5",
        filesTouched: [],
        finalComplete: true,
      } as unknown as RunTurnResult["trace"],
    };
  };
}

let root: string;
let cwd: string;
let store: InstanceType<typeof SessionStore>;
let savedDisableMemory: string | undefined;
let savedRecord: string | undefined;

beforeEach(async () => {
  savedDisableMemory = process.env["OXAGEN_DISABLE_MEMORY"];
  savedRecord = process.env["OXAGEN_FLEET_RECORD"];
  process.env["OXAGEN_DISABLE_MEMORY"] = "1";
  delete process.env["OXAGEN_FLEET_RECORD"];
  const base = await mkdtemp(join(tmpdir(), "oxagen-runner-record-"));
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
  if (savedRecord === undefined) delete process.env["OXAGEN_FLEET_RECORD"];
  else process.env["OXAGEN_FLEET_RECORD"] = savedRecord;
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
    title: "record test session",
    prompt: "do the recorded thing",
    owner: "tui",
    pid: process.pid,
    cwd,
    mode: "once",
    state: "queued",
    ...overrides,
  });
}

function recordStoreFor(sid: string): ReturnType<typeof openRecordStore> {
  return openRecordStore(sessionDir(root, sid));
}

describe("runSession — ADR-028 recording (default on)", () => {
  it("writes run.meta, turn.start/turn.end, fs layers, and full tool I/O blobs", async () => {
    const meta = await createMeta({
      model: "anthropic/claude-haiku-4-5",
      agent: "coder",
    });
    const calls: RunTurnOptions[] = [];
    const fake = makeFakeRunTurn({ calls, base: { invokeWrappedTool: true } });

    const result = await runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
    });
    expect(result.state).toBe("done");

    const recordStore = recordStoreFor(meta.sid);
    // tool.io blob writes are fire-and-forget in the recorder — poll for them.
    let records: ReplayRecord[] = [];
    await until(async () => {
      records = await recordStore.readRecords();
      return (
        records.some((r) => r.t === "tool.io") &&
        records.some((r) => r.t === "turn.end")
      );
    });

    const runMeta = records.find((r) => r.t === "run.meta");
    expect(runMeta).toBeTruthy();
    if (runMeta?.t === "run.meta") {
      expect(runMeta.prompt).toBe("do the recorded thing");
      expect(runMeta.model).toBe("anthropic/claude-haiku-4-5");
      expect(runMeta.agent).toBe("coder");
      expect(runMeta.cwd).toBe(cwd);
      // cliVersion rides along from the CLI's own package.json.
      expect(runMeta.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
    }

    // Baseline layer 0 exists (empty tmp cwd is not a git repo → no files).
    const baseline = records.find((r) => r.t === "fs.layer" && r.turn === 0);
    expect(baseline).toBeTruthy();

    const turnStart = records.find((r) => r.t === "turn.start");
    expect(turnStart).toMatchObject({
      turn: 1,
      prompt: "do the recorded thing",
    });

    // The wrapped tool's FULL input/output round-tripped through the blob store.
    const toolIo = records.find((r) => r.t === "tool.io");
    expect(toolIo).toBeTruthy();
    if (toolIo?.t === "tool.io") {
      expect(toolIo.name).toBe("echo");
      expect(toolIo.ok).toBe(true);
      expect(toolIo.callId).toBe("call-1");
      expect(await recordStore.getJsonBlob(toolIo.inputRef)).toEqual({
        value: 42,
      });
      expect(await recordStore.getJsonBlob(toolIo.outputRef)).toEqual({
        echoed: { value: 42 },
      });
    }

    // turn.end carries the full post-turn history blob.
    const turnEnd = records.find((r) => r.t === "turn.end");
    expect(turnEnd).toBeTruthy();
    if (turnEnd?.t === "turn.end") {
      expect(turnEnd.turn).toBe(1);
      expect(turnEnd.steps).toBe(2);
      expect(await recordStore.getJsonBlob(turnEnd.historyRef)).toEqual([
        { content: "Hello world", role: "assistant" },
      ]);
    }
  });

  it("auto-distills a failed session: distill record + record/distilled.json", async () => {
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

    const recordStore = recordStoreFor(meta.sid);
    const records = await recordStore.readRecords();
    const distill = records.find((r) => r.t === "distill");
    expect(distill).toBeTruthy();
    if (distill?.t === "distill") {
      expect(distill.reason).toBe("failed");
      expect(distill.isPushed).toBe(false);
      // The blob-stored item and the human-readable copy agree.
      const blobItem = await recordStore.getJsonBlob(distill.itemRef);
      const fileItem = JSON.parse(
        await readFile(join(recordStore.rootDir, "distilled.json"), "utf8"),
      ) as { input: string; metadata: Record<string, unknown> };
      expect(blobItem).toEqual(fileItem);
      expect(fileItem.input).toBe("do the recorded thing");
      expect(fileItem.metadata["reason"]).toBe("failed");
      expect(fileItem.metadata["error"]).toBe("engine exploded");
      expect(fileItem.metadata["sid"]).toBe(meta.sid);
    }

    // Seqs stay contiguous across the post-hoc distill writer.
    const seqs = records.map((r) => r.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("OXAGEN_FLEET_RECORD=0 disables recording entirely (no record dir)", async () => {
    process.env["OXAGEN_FLEET_RECORD"] = "0";
    const meta = await createMeta({ mode: "once" });
    const calls: RunTurnOptions[] = [];
    const fake = makeFakeRunTurn({ calls, base: { invokeWrappedTool: true } });

    const result = await runSession({
      store,
      meta,
      ai: fakeAi,
      runTurnImpl: fake,
    });
    expect(result.state).toBe("done");

    // No record/ directory was ever created — not even for the failed path.
    await expect(
      stat(join(sessionDir(root, meta.sid), "record")),
    ).rejects.toThrow();
    // Today's behavior preserved exactly: the runner passes the extras' own
    // wrapTools through (the mock's identity fn), with no recorder layered on —
    // a recorder wrapper would return a NEW tool set object.
    const probe = { marker: { description: "m" } } as unknown as ToolSet;
    expect(calls[0]?.wrapTools?.(probe)).toBe(probe);
  });

  it("seeds a resumed session's history from the source session's record", async () => {
    // Source session: one settled turn whose history is a known message list.
    const sourceMessages: ModelMessage[] = [
      { role: "user", content: "original ask" },
      { role: "assistant", content: "original answer" },
    ];
    const sourceMeta = await createMeta({ mode: "once" });
    const sourceCalls: RunTurnOptions[] = [];
    const sourceFake = makeFakeRunTurn({
      calls: sourceCalls,
      base: { messages: sourceMessages },
    });
    const sourceResult = await runSession({
      store,
      meta: sourceMeta,
      ai: fakeAi,
      runTurnImpl: sourceFake,
    });
    expect(sourceResult.state).toBe("done");

    // Fork: resumeOf points at the source's turn 1.
    const forkMeta = await createMeta({
      mode: "once",
      resumeOf: { sid: sourceMeta.sid, turn: 1 },
    });
    const forkCalls: RunTurnOptions[] = [];
    const forkFake = makeFakeRunTurn({ calls: forkCalls });
    const forkResult = await runSession({
      store,
      meta: forkMeta,
      ai: fakeAi,
      runTurnImpl: forkFake,
    });
    expect(forkResult.state).toBe("done");

    // Turn 1 of the fork ran with the source's reconstructed history.
    expect(forkCalls[0]?.history).toEqual(sourceMessages);
  });

  it("continues with empty history (non-fatal error event) when the resume source has no record", async () => {
    const forkMeta = await createMeta({
      mode: "once",
      resumeOf: { sid: "s-never-existed-0000", turn: 2 },
    });
    const forkCalls: RunTurnOptions[] = [];
    const forkFake = makeFakeRunTurn({ calls: forkCalls });
    const result = await runSession({
      store,
      meta: forkMeta,
      ai: fakeAi,
      runTurnImpl: forkFake,
    });
    expect(result.state).toBe("done");
    expect(forkCalls[0]?.history).toBeUndefined();

    const events = await store.readEvents(forkMeta.sid);
    const resumeError = events.find(
      (e) => e.type === "error" && e.message.includes("resume:"),
    );
    expect(resumeError).toBeTruthy();
    if (resumeError?.type === "error") expect(resumeError.fatal).toBe(false);
  });
});
