import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecPort } from "./recorder.js";
import {
  readRun,
  reconstructHistory,
  removeWorktree,
  restoreFsAtTurn,
  verifyRun,
} from "./restore.js";
import { RecordStore } from "./store.js";

let dir: string;
let store: RecordStore;

const HEAD = "1234567890abcdef1234567890abcdef12345678";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "replay-restore-"));
  store = new RecordStore({ dir: join(dir, "record") });
  await store.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a two-turn recorded run and return useful refs. */
async function seedRun() {
  const writer = store.openWriter({ sid: "s-1", now: () => 1720000000000 });
  const baselineBlob = await store.putBlob("baseline dirty content");
  const t1File = await store.putBlob("turn 1 content");
  const t2File = await store.putBlob("turn 2 content");
  const h1 = await store.putJsonBlob([{ role: "user", content: "go" }]);
  const h2 = await store.putJsonBlob([
    { role: "user", content: "go" },
    { role: "assistant", content: "done" },
  ]);
  const toolIn = await store.putJsonBlob({ path: "a.ts" });
  const toolOut = await store.putJsonBlob({ ok: true });

  writer.append({
    t: "run.meta",
    cwd: dir,
    prompt: "go",
    model: "balanced",
    gitHead: HEAD,
  });
  writer.append({
    t: "fs.layer",
    turn: 0,
    files: [{ path: "dirty.ts", ref: baselineBlob.ref, bytes: 22 }],
  });
  writer.append({ t: "turn.start", turn: 1, prompt: "go" });
  writer.append({
    t: "tool.io",
    turn: 1,
    idx: 1,
    name: "edit_file",
    inputRef: toolIn.ref,
    outputRef: toolOut.ref,
    ok: true,
    durationMs: 5,
  });
  writer.append({
    t: "turn.end",
    turn: 1,
    historyRef: h1.ref,
    changedFiles: ["a.ts"],
    steps: 2,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
  });
  writer.append({
    t: "fs.layer",
    turn: 1,
    files: [{ path: "a.ts", ref: t1File.ref, bytes: 14 }],
  });
  writer.append({ t: "turn.start", turn: 2, prompt: "again" });
  writer.append({
    t: "turn.end",
    turn: 2,
    historyRef: h2.ref,
    changedFiles: ["a.ts", "dirty.ts"],
    steps: 1,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
  });
  writer.append({
    t: "fs.layer",
    turn: 2,
    files: [
      { path: "a.ts", ref: t2File.ref, bytes: 14 },
      { path: "dirty.ts", ref: null, bytes: 0 }, // Turn 2 deleted dirty.ts.
    ],
  });
  writer.append({ t: "feedback", verdict: "down", comment: "nope" });
  await writer.flush();
  return { h2 };
}

describe("readRun", () => {
  it("merges records into a structured run view", async () => {
    await seedRun();
    const run = await readRun(store);
    expect(run).not.toBeNull();
    expect(run?.sid).toBe("s-1");
    expect(run?.meta?.gitHead).toBe(HEAD);
    expect(run?.baseline?.files[0]?.path).toBe("dirty.ts");
    expect(run?.turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(run?.turns[0]?.toolCalls).toHaveLength(1);
    expect(run?.lastSettledTurn).toBe(2);
    expect(run?.feedback[0]).toMatchObject({ verdict: "down" });
  });

  it("returns null for an unrecorded session", async () => {
    const empty = new RecordStore({ dir: join(dir, "none") });
    expect(await readRun(empty)).toBeNull();
  });
});

describe("verifyRun", () => {
  it("passes a clean run", async () => {
    await seedRun();
    const run = await readRun(store);
    const result = await verifyRun(store, run!);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.refsChecked).toBeGreaterThanOrEqual(7);
  });

  it("fails on a missing blob and reports which ref", async () => {
    await seedRun();
    const run = await readRun(store);
    const ref = run!.turns[0]!.end!.historyRef;
    await rm(join(store.rootDir, "blobs", ref));
    const result = await verifyRun(store, run!);
    expect(result.ok).toBe(false);
    expect(result.issues.join("\n")).toContain("turn 1 history");
  });

  it("fails on a corrupted blob (hash mismatch)", async () => {
    await seedRun();
    const run = await readRun(store);
    const ref = run!.turns[0]!.toolCalls[0]!.inputRef;
    await writeFile(join(store.rootDir, "blobs", ref), "tampered");
    const result = await verifyRun(store, run!);
    expect(result.ok).toBe(false);
    expect(result.issues.join("\n")).toContain("corrupt");
  });

  it("reports an unsettled tail turn without hard-failing", async () => {
    await seedRun();
    const writer = store.openWriter({ sid: "s-1", lastSeq: 10 });
    writer.append({ t: "turn.start", turn: 3, prompt: "crashed mid-turn" });
    await writer.flush();
    const run = await readRun(store);
    const result = await verifyRun(store, run!);
    expect(result.ok).toBe(true);
    expect(result.issues.join("\n")).toContain("turn 3 never settled");
  });
});

describe("reconstructHistory", () => {
  it("returns the full history after a settled turn", async () => {
    await seedRun();
    const run = await readRun(store);
    const history = await reconstructHistory(store, run!, 2);
    expect(history).toEqual([
      { content: "go", role: "user" },
      { content: "done", role: "assistant" },
    ]);
  });

  it("returns null for an unsettled or unknown turn", async () => {
    await seedRun();
    const run = await readRun(store);
    expect(await reconstructHistory(store, run!, 99)).toBeNull();
  });

  it("refuses truncated history", async () => {
    await seedRun();
    const truncated = await store.putJsonBlob({
      __truncated: true,
      bytes: 10,
      sha256: "a".repeat(64),
      head: "[",
    });
    const writer = store.openWriter({ sid: "s-1", lastSeq: 10 });
    writer.append({
      t: "turn.end",
      turn: 3,
      historyRef: truncated.ref,
      changedFiles: [],
      steps: 0,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    await writer.flush();
    const run = await readRun(store);
    expect(await reconstructHistory(store, run!, 3)).toBeNull();
  });
});

describe("restoreFsAtTurn", () => {
  /** Fake `git worktree add`: create the target dir with a HEAD-state file. */
  const fakeExec: ExecPort = async (cmd, args) => {
    if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
      const target = args[3]!;
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "dirty.ts"), "HEAD content");
      return { stdout: "", code: 0 };
    }
    if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
      return { stdout: "", code: 0 };
    }
    return { stdout: "", code: 1 };
  };

  it("restores baseline + layers up to the requested turn", async () => {
    await seedRun();
    const run = await readRun(store);
    const target = join(dir, "scratch-t1");
    const result = await restoreFsAtTurn({
      store,
      run: run!,
      turn: 1,
      targetDir: target,
      exec: fakeExec,
    });
    expect(result.warnings).toEqual([]);
    // Baseline overlays HEAD state; turn 1 layer adds a.ts; dirty.ts not yet deleted.
    expect(await readFile(join(target, "dirty.ts"), "utf8")).toBe(
      "baseline dirty content",
    );
    expect(await readFile(join(target, "a.ts"), "utf8")).toBe("turn 1 content");
  });

  it("applies deletions when restoring a later turn", async () => {
    await seedRun();
    const run = await readRun(store);
    const target = join(dir, "scratch-t2");
    await restoreFsAtTurn({
      store,
      run: run!,
      turn: 2,
      targetDir: target,
      exec: fakeExec,
    });
    expect(await readFile(join(target, "a.ts"), "utf8")).toBe("turn 2 content");
    await expect(stat(join(target, "dirty.ts"))).rejects.toThrow();
  });

  it("throws without a recorded git HEAD", async () => {
    const bare = new RecordStore({ dir: join(dir, "bare-record") });
    await bare.init();
    const writer = bare.openWriter({ sid: "s-2" });
    writer.append({ t: "run.meta", cwd: dir, prompt: "go" });
    await writer.flush();
    const run = await readRun(bare);
    await expect(
      restoreFsAtTurn({
        store: bare,
        run: run!,
        turn: 1,
        targetDir: join(dir, "x"),
        exec: fakeExec,
      }),
    ).rejects.toThrow(/git/i);
  });

  it("surfaces worktree failures with the exit code", async () => {
    await seedRun();
    const run = await readRun(store);
    const failingExec: ExecPort = async () => ({ stdout: "", code: 128 });
    await expect(
      restoreFsAtTurn({
        store,
        run: run!,
        turn: 1,
        targetDir: join(dir, "y"),
        exec: failingExec,
      }),
    ).rejects.toThrow("exit 128");
  });
});

describe("removeWorktree", () => {
  it("removes the scratch dir even when git worktree remove fails", async () => {
    const target = join(dir, "scratch-rm");
    await mkdir(target, { recursive: true });
    const exec: ExecPort = async () => ({ stdout: "", code: 1 });
    await removeWorktree({ repoCwd: dir, targetDir: target, exec });
    await expect(stat(target)).rejects.toThrow();
  });
});
