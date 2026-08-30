import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, type ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSessionRecorder, type ExecPort } from "./recorder.js";
import { RecordStore } from "./store.js";

let cwd: string;
let recordDir: string;
let store: RecordStore;

const HEAD = "1234567890abcdef1234567890abcdef12345678";

/** A fake git: HEAD sha + one dirty file. */
const fakeExec: ExecPort = async (cmd, args) => {
  if (cmd === "git" && args.includes("rev-parse"))
    return { stdout: `${HEAD}\n`, code: 0 };
  if (cmd === "git" && args.includes("status")) {
    // The recorder must ask for unquoted paths, or non-ASCII files are lost.
    expect(args).toContain("core.quotePath=false");
    return { stdout: " M dirty.ts\n?? new.ts\n", code: 0 };
  }
  return { stdout: "", code: 1 };
};

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "replay-cwd-"));
  recordDir = join(cwd, "record");
  store = new RecordStore({ dir: recordDir });
  await writeFile(join(cwd, "dirty.ts"), "dirty content");
  await writeFile(join(cwd, "new.ts"), "new content");
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function makeRecorder(
  overrides: { exec?: ExecPort; onError?: (m: string) => void } = {},
) {
  return createSessionRecorder({
    store,
    sid: "s-1",
    cwd,
    exec: overrides.exec ?? fakeExec,
    onError: overrides.onError,
    now: () => 1720000000000,
  });
}

describe("start", () => {
  it("records run.meta with git head and a baseline layer of dirty files", async () => {
    const recorder = makeRecorder();
    await recorder.start({
      prompt: "fix it",
      model: "balanced",
      cliVersion: "1.0.0",
    });
    expect(recorder.isRecording).toBe(true);
    await recorder.flush();

    const records = await store.readRecords();
    expect(records[0]).toMatchObject({
      t: "run.meta",
      cwd,
      prompt: "fix it",
      model: "balanced",
      cliVersion: "1.0.0",
      gitHead: HEAD,
    });
    const baseline = records[1];
    expect(baseline).toMatchObject({ t: "fs.layer", turn: 0 });
    if (baseline?.t === "fs.layer") {
      expect(baseline.files.map((f) => f.path).sort()).toEqual([
        "dirty.ts",
        "new.ts",
      ]);
      for (const file of baseline.files) {
        expect(file.ref).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it("omits gitHead outside a git repo and still records", async () => {
    const recorder = makeRecorder({
      exec: async () => ({ stdout: "", code: 128 }),
    });
    await recorder.start({ prompt: "go" });
    await recorder.flush();
    const records = await store.readRecords();
    expect(records[0]).toMatchObject({ t: "run.meta" });
    expect(
      records[0] && "gitHead" in records[0] ? records[0].gitHead : undefined,
    ).toBeUndefined();
  });
});

describe("wrapTools", () => {
  it("records full input and output for a successful tool call", async () => {
    const recorder = makeRecorder();
    await recorder.start({ prompt: "go" });
    recorder.turnStart(1, "go");

    const tools: ToolSet = {
      read_file: tool({
        description: "read",
        inputSchema: z.object({ path: z.string() }),
        execute: async (input) => ({
          content: `read:${JSON.stringify(input)}`,
        }),
      }),
    };
    const wrapped = recorder.wrapTools(tools);
    const result = await (
      wrapped["read_file"] as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute({ path: "a.ts" }, { toolCallId: "call_9" });
    expect(result).toEqual({ content: 'read:{"path":"a.ts"}' });

    await vi.waitFor(async () => {
      const records = await store.readRecords();
      const io = records.find((r) => r.t === "tool.io");
      expect(io).toBeDefined();
    });
    await recorder.flush();
    const io = (await store.readRecords()).find((r) => r.t === "tool.io");
    expect(io).toMatchObject({
      t: "tool.io",
      turn: 1,
      idx: 1,
      name: "read_file",
      callId: "call_9",
      ok: true,
    });
    if (io?.t === "tool.io") {
      expect(await store.getJsonBlob(io.inputRef)).toEqual({ path: "a.ts" });
      expect(await store.getJsonBlob(io.outputRef)).toEqual({
        content: 'read:{"path":"a.ts"}',
      });
    }
  });

  it("records ok:false with the error and rethrows on tool failure", async () => {
    const recorder = makeRecorder();
    await recorder.start({ prompt: "go" });
    recorder.turnStart(1, "go");

    const tools: ToolSet = {
      bash: tool({
        description: "run",
        inputSchema: z.object({ cmd: z.string() }),
        execute: async (): Promise<{ stdout: string }> => {
          throw new Error("command exploded");
        },
      }),
    };
    const wrapped = recorder.wrapTools(tools);
    await expect(
      (
        wrapped["bash"] as {
          execute: (i: unknown, o: unknown) => Promise<unknown>;
        }
      ).execute({ cmd: "boom" }, {}),
    ).rejects.toThrow("command exploded");

    await vi.waitFor(async () => {
      const io = (await store.readRecords()).find((r) => r.t === "tool.io");
      expect(io).toBeDefined();
    });
    const io = (await store.readRecords()).find((r) => r.t === "tool.io");
    expect(io).toMatchObject({ ok: false });
    if (io?.t === "tool.io") {
      expect(await store.getJsonBlob(io.outputRef)).toEqual({
        error: "command exploded",
      });
    }
  });

  it("flush awaits captures still in flight when the session finalizes", async () => {
    const recorder = makeRecorder();
    await recorder.start({ prompt: "go" });
    recorder.turnStart(1, "go");

    const tools: ToolSet = {
      write_file: tool({
        description: "write",
        inputSchema: z.object({ path: z.string() }),
        execute: async () => ({ written: true }),
      }),
    };
    const wrapped = recorder.wrapTools(tools);
    await (
      wrapped["write_file"] as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute({ path: "last.ts" }, { toolCallId: "call_last" });

    // No vi.waitFor: flush alone must be enough, or the final turn's tool
    // calls are dropped from the record.
    await recorder.flush();
    const io = (await store.readRecords()).find((r) => r.t === "tool.io");
    expect(io).toMatchObject({ name: "write_file", callId: "call_last" });
  });

  it("passes through tools without execute untouched", () => {
    const recorder = makeRecorder();
    const provider = { description: "provider-side" } as ToolSet[string];
    const wrapped = recorder.wrapTools({ remote: provider });
    expect(wrapped["remote"]).toBe(provider);
  });
});

describe("turn lifecycle", () => {
  it("records turn.start, turn.end with history blob, and the turn's fs layer", async () => {
    const recorder = makeRecorder();
    await recorder.start({ prompt: "go" });
    recorder.turnStart(1, "go");
    await writeFile(join(cwd, "made.ts"), "made by turn 1");
    await recorder.turnEnd({
      turn: 1,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "done" },
      ],
      changedFiles: ["made.ts", "removed.ts"],
      steps: 4,
      stopReason: "complete",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    });
    await recorder.flush();

    const records = await store.readRecords();
    const start = records.find((r) => r.t === "turn.start");
    const end = records.find((r) => r.t === "turn.end");
    const layer = records.find((r) => r.t === "fs.layer" && r.turn === 1);
    expect(start).toMatchObject({ turn: 1, prompt: "go" });
    expect(end).toMatchObject({ turn: 1, steps: 4, stopReason: "complete" });
    if (end?.t === "turn.end") {
      const history = await store.getJsonBlob(end.historyRef);
      expect(history).toEqual([
        { content: "go", role: "user" },
        { content: "done", role: "assistant" },
      ]);
    }
    if (layer?.t === "fs.layer") {
      const byPath = new Map(layer.files.map((f) => [f.path, f]));
      expect(byPath.get("made.ts")?.ref).toMatch(/^[0-9a-f]{64}$/);
      expect(byPath.get("removed.ts")?.ref).toBeNull(); // Missing file → tombstone.
    }
  });

  it("never snapshots paths escaping the tree", async () => {
    const recorder = makeRecorder();
    await recorder.start({ prompt: "go" });
    recorder.turnStart(1, "go");
    await recorder.turnEnd({
      turn: 1,
      messages: [],
      changedFiles: ["../outside.ts", "/etc/passwd", "ok.ts"],
      steps: 1,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    await recorder.flush();
    const layer = (await store.readRecords()).find(
      (r) => r.t === "fs.layer" && r.turn === 1,
    );
    if (layer?.t === "fs.layer") {
      expect(layer.files.map((f) => f.path)).toEqual(["ok.ts"]);
    }
  });
});

describe("failure stance", () => {
  it("disables itself and reports once when the store cannot be written", async () => {
    // Make the record dir path unusable by pre-creating it as a FILE.
    await rm(recordDir, { recursive: true, force: true });
    await writeFile(recordDir, "not a directory");
    const onError = vi.fn();
    const recorder = makeRecorder({ onError });
    await recorder.start({ prompt: "go" });
    expect(recorder.isRecording).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    // Subsequent calls are inert, not throwing.
    recorder.turnStart(1, "go");
    await recorder.turnEnd({
      turn: 1,
      messages: [],
      changedFiles: [],
      steps: 0,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("skips files over the layer ceiling with an explicit isSkipped marker", async () => {
    const recorder = makeRecorder();
    await recorder.start({ prompt: "go" });
    recorder.turnStart(1, "go");
    await mkdir(join(cwd, "sub"), { recursive: true });
    // 8 MB + 1 byte.
    await writeFile(
      join(cwd, "sub", "huge.bin"),
      Buffer.alloc(8 * 1024 * 1024 + 1, 120),
    );
    await recorder.turnEnd({
      turn: 1,
      messages: [],
      changedFiles: ["sub/huge.bin"],
      steps: 1,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    await recorder.flush();
    const layer = (await store.readRecords()).find(
      (r) => r.t === "fs.layer" && r.turn === 1,
    );
    if (layer?.t === "fs.layer") {
      expect(layer.files[0]).toMatchObject({
        path: "sub/huge.bin",
        ref: null,
        isSkipped: true,
      });
    }
  });
});
