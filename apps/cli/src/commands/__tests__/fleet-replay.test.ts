/**
 * Tests for the ADR-028 `oxagen fleet` time-travel verbs — replay, bisect,
 * resume, feedback, distill — against a real SessionStore + record store
 * seeded in a throwaway OXAGEN_FLEET_DIR. Git and the platform API never run:
 * the exec port, shell probe, and worker spawner are injected fakes, and every
 * assertion covers both sides of the dual-mode contract (JSON on stdout,
 * chrome/errors on stderr, exit codes).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openRecordStore,
  type ExecPort,
  type RecordStore,
} from "@oxagen/replay";

// Controllable platform-API seam: `fleet distill --push` goes through the
// shared lib/api client; the mock lets tests drive logged-out, find-or-create,
// and push-failure paths without HTTP.
const apiMock = vi.hoisted(() => ({
  ctx: null as Record<string, string> | null,
  datasets: [] as Array<{ datasetId: string; slug: string }>,
  posts: [] as Array<{ path: string; body: unknown }>,
  failPostWith: null as string | null,
}));
vi.mock("../../lib/api.js", () => ({
  resolveApiContext: () => apiMock.ctx,
  apiGetOrThrow: async (_path: string) => ({ datasets: apiMock.datasets }),
  apiPostOrThrow: async (path: string, body: unknown) => {
    if (apiMock.failPostWith !== null) throw new Error(apiMock.failPostWith);
    apiMock.posts.push({ path, body });
    if (path === "eval/datasets") {
      return {
        datasetId: "ds_internal",
        publicId: "ds_pub_1",
        slug: "created",
      };
    }
    return { datasetId: "ds_pub_1", added: 1, itemCount: 1 };
  },
}));
import {
  distillReasonFor,
  handleFleetBisect,
  handleFleetDistill,
  handleFleetFeedback,
  handleFleetReplay,
  handleFleetResume,
} from "../fleet.js";
import type { CommandWriter } from "../../lib/capture-writer.js";
import { fleetRoot, sessionDir } from "../../sessions/paths.js";
import { SessionStore, type SessionMeta } from "../../sessions/store.js";

function memoryWriter(): {
  writer: CommandWriter;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (line) => {
        out.push(line);
      },
      writeErr: (line) => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

let base: string;
let projectCwd: string;
let store: SessionStore;
const savedExit = process.exitCode;
const savedEnv = process.env["OXAGEN_FLEET_DIR"];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "oxagen-fleet-replay-"));
  process.env["OXAGEN_FLEET_DIR"] = join(base, "fleet");
  projectCwd = join(base, "project");
  store = new SessionStore({ root: fleetRoot(projectCwd) });
  apiMock.ctx = null;
  apiMock.datasets = [];
  apiMock.posts = [];
  apiMock.failPostWith = null;
});

afterEach(async () => {
  process.exitCode = savedExit;
  if (savedEnv === undefined) delete process.env["OXAGEN_FLEET_DIR"];
  else process.env["OXAGEN_FLEET_DIR"] = savedEnv;
  await rm(base, { recursive: true, force: true });
});

/** Fake git exec: every call "succeeds" — restore then writes layers itself. */
const fakeExec: ExecPort = async () => ({ stdout: "", code: 0 });

interface SeedOptions {
  sid: string;
  state?: SessionMeta["state"];
  /** Settled turns to record (default 2). Layer k writes state.txt = "k". */
  turns?: number;
  /** Append an envelope `error` event (feeds the distilled item's metadata). */
  errorMessage?: string;
  /** Record no git baseline (run.meta without gitHead) — restore must refuse. */
  withoutGitHead?: boolean;
}

/** Seed one session (meta + envelope) AND its ADR-028 record sidecar. */
async function seedRecordedRun(over: SeedOptions): Promise<RecordStore> {
  const turns = over.turns ?? 2;
  const meta = await store.createSession({
    sid: over.sid,
    title: "seeded",
    prompt: "seeded prompt",
    owner: "worker",
    pid: 0,
    cwd: projectCwd,
    mode: "conversation",
  });
  const envelope = store.openWriter(meta);
  if (over.errorMessage !== undefined) {
    envelope.append({ type: "error", message: over.errorMessage, fatal: true });
  }
  if (over.state !== undefined) envelope.patchMeta({ state: over.state });
  await envelope.flush();

  const recordStore = openRecordStore(
    sessionDir(fleetRoot(projectCwd), over.sid),
  );
  await recordStore.init();
  const writer = recordStore.openWriter({ sid: over.sid });
  writer.append({
    t: "run.meta",
    cwd: projectCwd,
    prompt: "seeded prompt",
    model: "anthropic/claude-haiku-4-5",
    cliVersion: "1.0.0",
    ...(over.withoutGitHead ? {} : { gitHead: "a".repeat(40) }),
  });
  const baseline = await recordStore.putBlob("0");
  writer.append({
    t: "fs.layer",
    turn: 0,
    files: [{ path: "state.txt", ref: baseline.ref, bytes: 1 }],
  });
  for (let turn = 1; turn <= turns; turn++) {
    writer.append({
      t: "turn.start",
      turn,
      prompt: turn === 1 ? "seeded prompt" : `follow-up ${turn}`,
    });
    const input = await recordStore.putBlob(
      JSON.stringify({ command: `cmd ${turn}` }),
    );
    const output = await recordStore.putBlob(
      JSON.stringify({ ok: true, turn }),
    );
    writer.append({
      t: "tool.io",
      turn,
      idx: turn,
      name: "bash",
      inputRef: input.ref,
      outputRef: output.ref,
      ok: true,
      durationMs: 5,
    });
    const history = await recordStore.putBlob(
      JSON.stringify([{ role: "assistant", content: `answer ${turn}` }]),
    );
    writer.append({
      t: "turn.end",
      turn,
      historyRef: history.ref,
      changedFiles: ["state.txt"],
      steps: 2,
      stopReason: "complete",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    });
    const layer = await recordStore.putBlob(String(turn));
    writer.append({
      t: "fs.layer",
      turn,
      files: [
        { path: "state.txt", ref: layer.ref, bytes: String(turn).length },
      ],
    });
  }
  await writer.flush();
  return recordStore;
}

// ── replay ───────────────────────────────────────────────────────────────────

describe("fleet replay", () => {
  it("errors cleanly when the session has no record (recording off / pre-ADR-028)", async () => {
    const meta = await store.createSession({
      sid: "s-aaa-0001",
      title: "no record",
      prompt: "p",
      owner: "worker",
      pid: 0,
      cwd: projectCwd,
      mode: "once",
    });
    const { writer, out, err } = memoryWriter();
    await handleFleetReplay(meta.sid, { json: true, cwd: projectCwd }, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("no replay record");
    expect(process.exitCode).toBe(1);
  });

  it("--json --verify emits the full run view with a clean integrity report", async () => {
    await seedRecordedRun({ sid: "s-aaa-0002", state: "done", turns: 2 });
    const { writer, out, err } = memoryWriter();
    await handleFleetReplay(
      "s-aaa-0002",
      { json: true, verify: true, cwd: projectCwd },
      writer,
    );
    expect(err).toEqual([]);
    const view = JSON.parse(out.join("")) as {
      sid: string;
      model?: string;
      gitHead?: string;
      lastSettledTurn: number;
      turns: Array<{
        turn: number;
        prompt: string;
        settled: boolean;
        changedFiles: string[];
        toolCalls: Array<{ name: string; ok: boolean; input?: unknown }>;
      }>;
      verify: { ok: boolean; issues: string[]; refsChecked: number };
    };
    expect(view.sid).toBe("s-aaa-0002");
    expect(view.model).toBe("anthropic/claude-haiku-4-5");
    expect(view.gitHead).toBe("a".repeat(40));
    expect(view.lastSettledTurn).toBe(2);
    expect(view.turns).toHaveLength(2);
    expect(view.turns[0]).toMatchObject({
      turn: 1,
      prompt: "seeded prompt",
      settled: true,
      changedFiles: ["state.txt"],
    });
    expect(view.turns[0]?.toolCalls[0]).toMatchObject({
      name: "bash",
      ok: true,
    });
    // Summary view: payloads only resolve with --turn.
    expect(view.turns[0]?.toolCalls[0]?.input).toBeUndefined();
    expect(view.verify.ok).toBe(true);
    expect(view.verify.issues).toEqual([]);
    expect(view.verify.refsChecked).toBeGreaterThan(0);
    expect(process.exitCode).toBe(savedExit);
  });

  it("--turn N resolves that turn's FULL tool input/output payloads", async () => {
    await seedRecordedRun({ sid: "s-aaa-0003", state: "done", turns: 2 });
    const { writer, out } = memoryWriter();
    await handleFleetReplay(
      "s-aaa-0003",
      { json: true, turn: "2", cwd: projectCwd },
      writer,
    );
    const view = JSON.parse(out.join("")) as {
      turns: Array<{
        turn: number;
        toolCalls: Array<{ input?: unknown; output?: unknown }>;
      }>;
    };
    const focused = view.turns.find((t) => t.turn === 2);
    expect(focused?.toolCalls[0]?.input).toEqual({ command: "cmd 2" });
    expect(focused?.toolCalls[0]?.output).toEqual({ ok: true, turn: 2 });
    const other = view.turns.find((t) => t.turn === 1);
    expect(other?.toolCalls[0]?.input).toBeUndefined();
  });

  it("rejects a non-integer --turn as a usage error (exit 2)", async () => {
    await seedRecordedRun({ sid: "s-aaa-0004", state: "done" });
    const { writer, err } = memoryWriter();
    await handleFleetReplay(
      "s-aaa-0004",
      { turn: "nope", cwd: projectCwd },
      writer,
    );
    expect(err.join("\n")).toContain("invalid --turn");
    expect(process.exitCode).toBe(2);
  });
});

// ── bisect ───────────────────────────────────────────────────────────────────

describe("fleet bisect", () => {
  it("requires --cmd (usage error, exit 2)", async () => {
    await seedRecordedRun({ sid: "s-bbb-0001", state: "failed" });
    const { writer, err } = memoryWriter();
    await handleFleetBisect(
      "s-bbb-0001",
      { json: true, cwd: projectCwd },
      writer,
    );
    expect(err.join("\n")).toContain("--cmd");
    expect(process.exitCode).toBe(2);
  });

  it("restore-and-probe finds the first bad turn (fake git, real layers)", async () => {
    // Layers write state.txt = turn number; the probe calls turns < 3 good, so
    // the first bad turn is 3 of 4.
    await seedRecordedRun({ sid: "s-bbb-0002", state: "failed", turns: 4 });
    const probeShell = async (_cmd: string, cwd: string): Promise<number> => {
      const state = Number.parseInt(
        await readFile(join(cwd, "state.txt"), "utf8"),
        10,
      );
      return state < 3 ? 0 : 1;
    };
    const { writer, out } = memoryWriter();
    await handleFleetBisect(
      "s-bbb-0002",
      {
        json: true,
        quiet: true,
        cmd: "check-state",
        cwd: projectCwd,
        execImpl: fakeExec,
        runShellImpl: probeShell,
      },
      writer,
    );
    const result = JSON.parse(out.join("")) as {
      firstBadTurn: number;
      goodTurn: number;
      badTurn: number;
      probes: Array<{ turn: number; isGood: boolean }>;
      prompt: string;
      toolCalls: Array<{ name: string }>;
    };
    expect(result.goodTurn).toBe(0);
    expect(result.badTurn).toBe(4); // defaulted to the last settled turn
    expect(result.firstBadTurn).toBe(3);
    expect(result.prompt).toBe("follow-up 3");
    expect(result.toolCalls[0]?.name).toBe("bash");
    expect(result.probes.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(savedExit);
  });
});

// ── resume ───────────────────────────────────────────────────────────────────

describe("fleet resume", () => {
  it("requires --turn (usage error, exit 2)", async () => {
    await seedRecordedRun({ sid: "s-ccc-0001", state: "done" });
    const { writer, err } = memoryWriter();
    await handleFleetResume(
      "s-ccc-0001",
      { json: true, cwd: projectCwd },
      writer,
    );
    expect(err.join("\n")).toContain("--turn");
    expect(process.exitCode).toBe(2);
  });

  it("restores a scratch worktree and dispatches a fork with resumeOf provenance", async () => {
    await seedRecordedRun({ sid: "s-ccc-0002", state: "done", turns: 3 });
    const spawned: Array<{ args: string[]; cwd: string }> = [];
    const { writer, out } = memoryWriter();
    await handleFleetResume(
      "s-ccc-0002",
      {
        json: true,
        turn: "2",
        cwd: projectCwd,
        execImpl: fakeExec,
        spawnImpl: (_cmd, args, options) => {
          spawned.push({ args, cwd: options.cwd });
          return { unref: () => {} };
        },
      },
      writer,
    );
    const result = JSON.parse(out.join("")) as {
      sid: string;
      resumedFrom: { sid: string; turn: number };
      scratchDir: string;
      prompt: string;
      model: string | null;
    };
    expect(result.resumedFrom).toEqual({ sid: "s-ccc-0002", turn: 2 });
    // Prompt defaults to the source's NEXT turn (rerun it against the fork).
    expect(result.prompt).toBe("follow-up 3");
    expect(result.model).toBe("anthropic/claude-haiku-4-5");
    expect(result.scratchDir).toContain(
      join("scratch", "resume-s-ccc-0002-t2-"),
    );
    // The restored tree carries the state AFTER turn 2.
    expect(await readFile(join(result.scratchDir, "state.txt"), "utf8")).toBe(
      "2",
    );

    // The fork landed in the SOURCE project's fleet, edits the scratch tree,
    // and its worker was spawned from the source fleet's anchor cwd.
    const forked = await store.readMeta(result.sid);
    expect(forked?.resumeOf).toEqual({ sid: "s-ccc-0002", turn: 2 });
    expect(forked?.cwd).toBe(result.scratchDir);
    expect(spawned[0]?.cwd).toBe(projectCwd);
    expect(spawned[0]?.args.slice(-3)).toEqual(["fleet", "worker", result.sid]);
  });
});

// ── feedback ─────────────────────────────────────────────────────────────────

describe("fleet feedback", () => {
  it("rejects a verdict other than up/down (usage, exit 2)", async () => {
    await seedRecordedRun({ sid: "s-ddd-0000", state: "done" });
    const { writer, err } = memoryWriter();
    await handleFleetFeedback(
      "s-ddd-0000",
      "meh",
      { json: true, cwd: projectCwd },
      writer,
    );
    expect(err.join("\n")).toContain("feedback verdict must be");
    expect(process.exitCode).toBe(2);
  });

  it("refuses a non-terminal session", async () => {
    await seedRecordedRun({ sid: "s-ddd-0001" }); // state stays queued → orphaned
    const { writer, err } = memoryWriter();
    await handleFleetFeedback(
      "s-ddd-0001",
      "up",
      { json: true, cwd: projectCwd },
      writer,
    );
    expect(err.join("\n")).toContain("feedback needs a finished");
    expect(process.exitCode).toBe(1);
  });

  it("up appends a feedback record with the comment — and does not distill", async () => {
    const recordStore = await seedRecordedRun({
      sid: "s-ddd-0002",
      state: "done",
    });
    const { writer, out } = memoryWriter();
    await handleFleetFeedback(
      "s-ddd-0002",
      "up",
      { json: true, message: "solid run", cwd: projectCwd },
      writer,
    );
    expect(JSON.parse(out.join(""))).toMatchObject({
      sid: "s-ddd-0002",
      verdict: "up",
      comment: "solid run",
      isDistilled: false,
    });
    const records = await recordStore.readRecords();
    const feedback = records.find((r) => r.t === "feedback");
    expect(feedback).toMatchObject({ verdict: "up", comment: "solid run" });
    expect(records.some((r) => r.t === "distill")).toBe(false);
    // Post-hoc writer continued the seq chain without collision.
    const seqs = records.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("down appends feedback AND auto-distills (thumbs_down) to distilled.json", async () => {
    const recordStore = await seedRecordedRun({
      sid: "s-ddd-0003",
      state: "done",
    });
    const { writer, out } = memoryWriter();
    await handleFleetFeedback(
      "s-ddd-0003",
      "down",
      { json: true, message: "went sideways", cwd: projectCwd },
      writer,
    );
    expect(JSON.parse(out.join(""))).toMatchObject({
      verdict: "down",
      isDistilled: true,
    });

    const records = await recordStore.readRecords();
    const distill = records.find((r) => r.t === "distill");
    expect(distill).toMatchObject({ reason: "thumbs_down", isPushed: false });

    const item = JSON.parse(
      await readFile(join(recordStore.rootDir, "distilled.json"), "utf8"),
    ) as { input: string; metadata: Record<string, unknown> };
    expect(item.input).toBe("seeded prompt");
    expect(item.metadata["reason"]).toBe("thumbs_down");
    expect(item.metadata["feedback"]).toBe("went sideways");
    expect(item.metadata["changedFiles"]).toEqual(["state.txt"]);
    expect(item.metadata["gitHead"]).toBe("a".repeat(40));
  });
});

// ── distill ──────────────────────────────────────────────────────────────────

describe("fleet distill", () => {
  it("distillReasonFor precedence: thumbs_down → failed → manual", () => {
    const run = (down: boolean) =>
      ({
        feedback: down ? [{ verdict: "down" as const }] : [],
      }) as unknown as Parameters<typeof distillReasonFor>[0];
    expect(distillReasonFor(run(true), "failed")).toBe("thumbs_down");
    expect(distillReasonFor(run(false), "failed")).toBe("failed");
    expect(distillReasonFor(run(false), "done")).toBe("manual");
  });

  it("local distill of a failed run: reason failed, envelope error captured, record appended", async () => {
    const recordStore = await seedRecordedRun({
      sid: "s-eee-0001",
      state: "failed",
      errorMessage: "turn 2 exploded",
    });
    const { writer, out, err } = memoryWriter();
    await handleFleetDistill(
      "s-eee-0001",
      { json: true, cwd: projectCwd },
      writer,
    );
    expect(err).toEqual([]);
    const result = JSON.parse(out.join("")) as {
      sid: string;
      reason: string;
      itemRef: string;
      isPushed: boolean;
      item: { input: string; metadata: Record<string, unknown> };
    };
    expect(result.reason).toBe("failed");
    expect(result.isPushed).toBe(false);
    expect(result.item.input).toBe("seeded prompt");
    expect(result.item.metadata["error"]).toBe("turn 2 exploded");
    expect(result.item.metadata["fate"]).toBe("failed");
    expect(result.item.metadata["turns"]).toBe(2);
    expect(result.item.metadata["cliVersion"]).toBe("1.0.0");

    const records = await recordStore.readRecords();
    const distill = records.find((r) => r.t === "distill");
    expect(distill).toMatchObject({
      reason: "failed",
      itemRef: result.itemRef,
      isPushed: false,
    });
    // The blob and the human-readable copy agree.
    expect(await recordStore.getJsonBlob(result.itemRef)).toEqual(
      JSON.parse(
        await readFile(join(recordStore.rootDir, "distilled.json"), "utf8"),
      ),
    );
    expect(process.exitCode).toBe(savedExit);
  });

  it("a prior thumbs-down wins the reason and carries its comment", async () => {
    const recordStore = await seedRecordedRun({
      sid: "s-eee-0002",
      state: "failed",
    });
    const feedbackIo = memoryWriter();
    await handleFleetFeedback(
      "s-eee-0002",
      "down",
      { json: true, message: "bad diff", cwd: projectCwd },
      feedbackIo.writer,
    );

    const { writer, out } = memoryWriter();
    await handleFleetDistill(
      "s-eee-0002",
      { json: true, cwd: projectCwd },
      writer,
    );
    const result = JSON.parse(out.join("")) as {
      reason: string;
      item: { metadata: Record<string, unknown> };
    };
    expect(result.reason).toBe("thumbs_down");
    expect(result.item.metadata["feedback"]).toBe("bad diff");

    // Two distill records now exist (feedback's + the manual one), seqs unique.
    const records = await recordStore.readRecords();
    expect(records.filter((r) => r.t === "distill")).toHaveLength(2);
    const seqs = records.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("errors cleanly on a session with no record", async () => {
    await store.createSession({
      sid: "s-eee-0003",
      title: "bare",
      prompt: "p",
      owner: "worker",
      pid: 0,
      cwd: projectCwd,
      mode: "once",
    });
    const { writer, err } = memoryWriter();
    await handleFleetDistill(
      "s-eee-0003",
      { json: true, cwd: projectCwd },
      writer,
    );
    expect(err.join("\n")).toContain("no replay record");
    expect(process.exitCode).toBe(1);
  });

  it("--push without an API context fails loudly, telling the user to log in — item still written locally", async () => {
    const recordStore = await seedRecordedRun({
      sid: "s-eee-0004",
      state: "failed",
    });
    const { writer, err } = memoryWriter();
    await handleFleetDistill(
      "s-eee-0004",
      { json: true, push: true, cwd: projectCwd },
      writer,
    );
    expect(err.join("\n")).toContain("oxagen login");
    expect(process.exitCode).toBe(1);
    // The local artifacts landed anyway, and the record reflects reality: not pushed.
    await expect(
      readFile(join(recordStore.rootDir, "distilled.json"), "utf8"),
    ).resolves.toContain("seeded prompt");
    const distill = (await recordStore.readRecords()).find(
      (r) => r.t === "distill",
    );
    expect(distill).toMatchObject({
      isPushed: false,
      datasetSlug: "fleet-distilled-failures",
    });
  });

  it("--push find-or-creates the dataset by slug and adds the item (isPushed true)", async () => {
    const recordStore = await seedRecordedRun({
      sid: "s-eee-0005",
      state: "failed",
    });
    apiMock.ctx = { apiUrl: "http://x", token: "t", org: "o", ws: "w" };
    const { writer, out, err } = memoryWriter();
    await handleFleetDistill(
      "s-eee-0005",
      { json: true, push: true, dataset: "created", cwd: projectCwd },
      writer,
    );
    expect(err).toEqual([]);
    const result = JSON.parse(out.join("")) as {
      isPushed: boolean;
      datasetSlug: string;
    };
    expect(result.isPushed).toBe(true);
    expect(result.datasetSlug).toBe("created");
    // No dataset matched the slug → created, then the item was added to it.
    expect(apiMock.posts.map((p) => p.path)).toEqual([
      "eval/datasets",
      "eval/datasets/items",
    ]);
    expect(apiMock.posts[1]?.body).toMatchObject({
      datasetPublicId: "ds_pub_1",
    });
    const distill = (await recordStore.readRecords()).find(
      (r) => r.t === "distill",
    );
    expect(distill).toMatchObject({ isPushed: true, datasetSlug: "created" });
  });

  it("--push reuses an existing dataset and records a failed push as isPushed false", async () => {
    const recordStore = await seedRecordedRun({
      sid: "s-eee-0006",
      state: "failed",
    });
    apiMock.ctx = { apiUrl: "http://x", token: "t", org: "o", ws: "w" };
    apiMock.datasets = [
      { datasetId: "ds_existing", slug: "fleet-distilled-failures" },
    ];
    apiMock.failPostWith = "Error 500 from eval/datasets/items";
    const { writer, err } = memoryWriter();
    await handleFleetDistill(
      "s-eee-0006",
      { json: true, push: true, cwd: projectCwd },
      writer,
    );
    expect(err.join("\n")).toContain("Error 500");
    expect(process.exitCode).toBe(1);
    const distill = (await recordStore.readRecords()).find(
      (r) => r.t === "distill",
    );
    expect(distill).toMatchObject({ isPushed: false });
  });
});

// ── pretty rendering ─────────────────────────────────────────────────────────

describe("fleet replay — pretty mode", () => {
  it("renders the run header, per-turn summaries, verdicts, and focused payloads", async () => {
    await seedRecordedRun({ sid: "s-fff-0001", state: "done", turns: 2 });
    const feedbackIo = memoryWriter();
    await handleFleetFeedback(
      "s-fff-0001",
      "down",
      { json: true, message: "nope", cwd: projectCwd },
      feedbackIo.writer,
    );
    process.exitCode = savedExit; // feedback path is not under test here

    const { writer, out } = memoryWriter();
    await handleFleetReplay(
      "s-fff-0001",
      { turn: "1", verify: true, cwd: projectCwd },
      writer,
    );
    const text = out.join("\n");
    expect(text).toContain("run s-fff-0001 — 2 settled turn(s)");
    expect(text).toContain("model anthropic/claude-haiku-4-5");
    expect(text).toContain("git aaaaaaaaaaaa");
    expect(text).toContain("feedback: down — nope");
    expect(text).toContain("distilled (thumbs_down) → local only");
    expect(text).toContain("turn 1 (2 step(s) · complete) — seeded prompt");
    expect(text).toContain("tool bash ✓ 5ms");
    // Focused turn 1 shows its full payloads, indented under labels.
    expect(text).toContain('"command": "cmd 1"');
    expect(text).not.toContain('"command": "cmd 2"');
    expect(text).toContain("changed: state.txt");
    expect(text).toContain("verify: ok");
    expect(process.exitCode).toBe(savedExit);
  });
});

// ── integrity + restore preconditions ────────────────────────────────────────

describe("fleet replay --verify — corruption", () => {
  it("fails verification (exit 1) when a blob no longer hashes to its ref", async () => {
    const recordStore = await seedRecordedRun({
      sid: "s-hhh-0001",
      state: "done",
    });
    // Corrupt one payload in place: content no longer matches its sha256 name.
    const toolIo = (await recordStore.readRecords()).find(
      (r) => r.t === "tool.io",
    );
    if (toolIo?.t !== "tool.io")
      throw new Error("seed lost its tool.io record");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(recordStore.rootDir, "blobs", toolIo.inputRef),
      "tampered",
    );

    const { writer, out } = memoryWriter();
    await handleFleetReplay(
      "s-hhh-0001",
      { json: true, verify: true, cwd: projectCwd },
      writer,
    );
    const view = JSON.parse(out.join("")) as {
      verify: { ok: boolean; issues: string[] };
    };
    expect(view.verify.ok).toBe(false);
    expect(view.verify.issues.join("\n")).toContain("corrupt");
    expect(process.exitCode).toBe(1);
  });
});

describe("restore preconditions", () => {
  it("bisect refuses a run recorded without a git baseline", async () => {
    await seedRecordedRun({
      sid: "s-hhh-0002",
      state: "failed",
      withoutGitHead: true,
    });
    const { writer, err } = memoryWriter();
    await handleFleetBisect(
      "s-hhh-0002",
      { json: true, cmd: "true", cwd: projectCwd },
      writer,
    );
    expect(err.join("\n")).toContain("no git baseline");
    expect(process.exitCode).toBe(1);
  });

  it("resume rejects --turn beyond the last settled turn (usage, exit 2)", async () => {
    await seedRecordedRun({ sid: "s-hhh-0003", state: "done", turns: 2 });
    const { writer, err } = memoryWriter();
    await handleFleetResume(
      "s-hhh-0003",
      { json: true, turn: "7", cwd: projectCwd },
      writer,
    );
    expect(err.join("\n")).toContain("0..2");
    expect(process.exitCode).toBe(2);
  });
});

// ── bisect flag validation ───────────────────────────────────────────────────

describe("fleet bisect — flag validation", () => {
  it("rejects non-integer --good/--bad (usage, exit 2)", async () => {
    await seedRecordedRun({ sid: "s-ggg-0001", state: "failed" });
    const { writer, err } = memoryWriter();
    await handleFleetBisect(
      "s-ggg-0001",
      { json: true, cmd: "true", good: "x", cwd: projectCwd },
      writer,
    );
    expect(err.join("\n")).toContain("--good/--bad");
    expect(process.exitCode).toBe(2);
  });

  it("rejects an empty bisect range (good ≥ bad)", async () => {
    await seedRecordedRun({ sid: "s-ggg-0002", state: "failed", turns: 1 });
    const { writer, err } = memoryWriter();
    await handleFleetBisect(
      "s-ggg-0002",
      { json: true, cmd: "true", good: "1", cwd: projectCwd },
      writer,
    );
    expect(err.join("\n")).toContain("nothing to bisect");
    expect(process.exitCode).toBe(2);
  });
});
