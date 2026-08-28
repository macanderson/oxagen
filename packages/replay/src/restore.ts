/**
 * The read side of time travel (ADR-028): load a recorded run, verify its
 * integrity, reconstruct model history at any turn, and restore the working
 * tree at any turn into a scratch directory.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { sha256Hex } from "./hash.js";
import {
  isTruncatedBlob,
  type LayerFile,
  type ReplayRecord,
} from "./records.js";
import type { ExecPort } from "./recorder.js";
import type { RecordStore } from "./store.js";

/** One turn of a recorded run, merged from its records. */
export interface ReplayTurn {
  turn: number;
  prompt: string;
  /** Present once the turn settled; a crashed turn has start only. */
  end?: Extract<ReplayRecord, { t: "turn.end" }>;
  toolCalls: Extract<ReplayRecord, { t: "tool.io" }>[];
  layer?: Extract<ReplayRecord, { t: "fs.layer" }>;
}

/** A fully-parsed recorded run. */
export interface ReplayRun {
  sid: string;
  meta: Extract<ReplayRecord, { t: "run.meta" }> | null;
  baseline: Extract<ReplayRecord, { t: "fs.layer" }> | null;
  turns: ReplayTurn[];
  feedback: Extract<ReplayRecord, { t: "feedback" }>[];
  distills: Extract<ReplayRecord, { t: "distill" }>[];
  records: ReplayRecord[];
  /** Highest settled turn (has a `turn.end`); 0 when none settled. */
  lastSettledTurn: number;
}

/** Parse the record log into a structured run view. */
export async function readRun(store: RecordStore): Promise<ReplayRun | null> {
  const records = await store.readRecords();
  if (records.length === 0) return null;
  const meta =
    records.find(
      (r): r is Extract<ReplayRecord, { t: "run.meta" }> => r.t === "run.meta",
    ) ?? null;
  const sid = records[0]?.sid ?? "";
  const turns = new Map<number, ReplayTurn>();
  let baseline: ReplayRun["baseline"] = null;
  const feedback: ReplayRun["feedback"] = [];
  const distills: ReplayRun["distills"] = [];

  const turnOf = (n: number, prompt = ""): ReplayTurn => {
    let t = turns.get(n);
    if (!t) {
      t = { turn: n, prompt, toolCalls: [] };
      turns.set(n, t);
    }
    return t;
  };

  for (const record of records) {
    switch (record.t) {
      case "turn.start":
        turnOf(record.turn).prompt = record.prompt;
        break;
      case "tool.io":
        turnOf(record.turn).toolCalls.push(record);
        break;
      case "turn.end":
        turnOf(record.turn).end = record;
        break;
      case "fs.layer":
        if (record.turn === 0) baseline = record;
        else turnOf(record.turn).layer = record;
        break;
      case "feedback":
        feedback.push(record);
        break;
      case "distill":
        distills.push(record);
        break;
      case "run.meta":
        break;
    }
  }

  const ordered = [...turns.values()].sort((a, b) => a.turn - b.turn);
  const lastSettledTurn = ordered.reduce(
    (max, t) => (t.end ? Math.max(max, t.turn) : max),
    0,
  );
  return {
    sid,
    meta,
    baseline,
    turns: ordered,
    feedback,
    distills,
    records,
    lastSettledTurn,
  };
}

export interface VerifyResult {
  ok: boolean;
  issues: string[];
  /** Counts for reporting: refs checked and blobs resolved. */
  refsChecked: number;
}

/**
 * Integrity check — the "point-in-time recovery you can trust" property:
 * sequence numbers contiguous, every blob ref resolves, and every resolved
 * blob hashes back to its ref. A crashed run (open turn without `turn.end`)
 * is reported as an issue but does not by itself fail verification.
 */
export async function verifyRun(
  store: RecordStore,
  run: ReplayRun,
): Promise<VerifyResult> {
  const issues: string[] = [];
  let refsChecked = 0;
  let hardFail = false;

  let expectedSeq = 0;
  for (const record of run.records) {
    expectedSeq += 1;
    if (record.seq !== expectedSeq) {
      issues.push(
        `record seq gap: expected ${expectedSeq}, found ${record.seq}`,
      );
      hardFail = true;
      expectedSeq = record.seq;
    }
  }
  if (!run.meta) {
    issues.push("missing run.meta record");
    hardFail = true;
  }

  const refs: Array<{ ref: string; what: string }> = [];
  for (const turn of run.turns) {
    if (turn.end)
      refs.push({
        ref: turn.end.historyRef,
        what: `turn ${turn.turn} history`,
      });
    else
      issues.push(
        `turn ${turn.turn} never settled (no turn.end — crashed or still running)`,
      );
    for (const call of turn.toolCalls) {
      refs.push({
        ref: call.inputRef,
        what: `tool ${call.name}#${call.idx} input`,
      });
      refs.push({
        ref: call.outputRef,
        what: `tool ${call.name}#${call.idx} output`,
      });
    }
    for (const file of turn.layer?.files ?? []) {
      if (file.ref)
        refs.push({
          ref: file.ref,
          what: `layer ${turn.turn} file ${file.path}`,
        });
    }
  }
  for (const file of run.baseline?.files ?? []) {
    if (file.ref)
      refs.push({ ref: file.ref, what: `baseline file ${file.path}` });
  }

  for (const { ref, what } of refs) {
    refsChecked += 1;
    const content = await store.getBlob(ref);
    if (content === null) {
      issues.push(`${what}: blob ${ref.slice(0, 12)}… missing`);
      hardFail = true;
      continue;
    }
    if (sha256Hex(content) !== ref) {
      issues.push(`${what}: blob ${ref.slice(0, 12)}… corrupt (hash mismatch)`);
      hardFail = true;
    }
  }

  return { ok: !hardFail, issues, refsChecked };
}

/**
 * The full model history after `turn` — exactly what the model would see
 * entering turn+1, i.e. what a resume seeds from. Returns null when the turn
 * never settled, the blob is missing, or the history was truncated at record
 * time (resuming from a lossy history would be silent corruption).
 */
export async function reconstructHistory(
  store: RecordStore,
  run: ReplayRun,
  turn: number,
): Promise<unknown[] | null> {
  const target = run.turns.find((t) => t.turn === turn);
  if (!target?.end) return null;
  const value = await store.getJsonBlob(target.end.historyRef);
  if (value === null || isTruncatedBlob(value) || !Array.isArray(value))
    return null;
  // Array.isArray narrows `unknown` to `any[]`; the real element type is unknown.
  return value as unknown[];
}

export interface RestoreResult {
  /** Files written / removed while applying layers. */
  applied: number;
  /** Human-readable caveats (skipped oversize files, unreadable snapshots). */
  warnings: string[];
}

/**
 * Materialize the working tree as it stood AFTER `turn` (0 = session start)
 * into `targetDir`: a detached git worktree at the recorded HEAD, then the
 * baseline layer, then every settled layer 1..turn in order.
 *
 * `targetDir` must not exist yet. The caller owns cleanup
 * ({@link removeWorktree}).
 */
export async function restoreFsAtTurn(args: {
  store: RecordStore;
  run: ReplayRun;
  turn: number;
  targetDir: string;
  exec: ExecPort;
}): Promise<RestoreResult> {
  const { store, run, turn, targetDir, exec } = args;
  const meta = run.meta;
  if (!meta) throw new Error("run has no run.meta record — cannot restore");
  if (!meta.gitHead) {
    throw new Error(
      "run recorded no git HEAD — filesystem restore requires a git repository",
    );
  }
  const wt = await exec(
    "git",
    ["worktree", "add", "--detach", targetDir, meta.gitHead],
    { cwd: meta.cwd },
  );
  if (wt.code !== 0) {
    throw new Error(
      `git worktree add failed (exit ${wt.code}) — is ${meta.gitHead.slice(0, 12)} still reachable?`,
    );
  }

  const layers: LayerFile[][] = [];
  if (run.baseline) layers.push(run.baseline.files);
  for (const t of run.turns) {
    if (t.turn <= turn && t.layer) layers.push(t.layer.files);
  }

  let applied = 0;
  const warnings: string[] = [];
  for (const layer of layers) {
    for (const file of layer) {
      if (isAbsolute(file.path) || file.path.split("/").includes("..")) {
        warnings.push(`refusing to restore suspicious path: ${file.path}`);
        continue;
      }
      const dest = join(targetDir, file.path);
      if (file.isSkipped) {
        warnings.push(
          `${file.path}: content was over the snapshot ceiling at record time — left at git state`,
        );
        continue;
      }
      if (file.ref === null) {
        await rm(dest, { force: true });
        applied += 1;
        continue;
      }
      const content = await store.getBlob(file.ref);
      if (content === null) {
        warnings.push(
          `${file.path}: snapshot blob missing — left at git state`,
        );
        continue;
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, content);
      applied += 1;
    }
  }
  return { applied, warnings };
}

/** Remove a scratch worktree created by {@link restoreFsAtTurn}. Best-effort. */
export async function removeWorktree(args: {
  repoCwd: string;
  targetDir: string;
  exec: ExecPort;
}): Promise<void> {
  await args
    .exec("git", ["worktree", "remove", "--force", args.targetDir], {
      cwd: args.repoCwd,
    })
    .catch(() => undefined);
  await rm(args.targetDir, { recursive: true, force: true }).catch(
    () => undefined,
  );
}
