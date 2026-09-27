// The memory runner's reads and writes (ADR-206), end to end over fakes.
//
// Capture and the digest read a wrapped run through the in-memory run stores
// the run handlers' tests share. The curator reads and writes the fixture
// steering repo through FakeGitHub. FakeMemoryStore keeps the five memory
// tables in memory and follows store.ts: a repeated dedupe key writes
// nothing, a run holds one reflection, and only an open memory PR settles.
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import { digestBytes } from "@oxagen/tacho";
import type { TachoFrameRow } from "@oxagen/telemetry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeGitHub, REPO } from "../context.steering.test-support";
import { logger } from "../logger";
import {
  memoryEvents,
  memoryStores,
  memoryTachoFrames,
  SCOPE,
  tachoRow,
  tachoSession,
} from "../run.test-support";
import type { DigestReflection } from "./digest";
import { memoryLineage, memoryRecordPath } from "./naming";
import {
  captureMemories,
  curateMemories,
  digestRun,
  ingestMemories,
  type MemoryRunnerDeps,
  prepareBranch,
  recallMemories,
} from "./runner";
import { statementHash } from "./statement";
import type {
  ActiveRecord,
  MemoryDraft,
  MemoryScope,
  MemoryStore,
  OpenMemoryPr,
  PrSettlement,
  RecallRequest,
  RecallStamp,
  RecentReflection,
  ReflectionDraft,
  Rejection,
  StoredMemory,
} from "./types";

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SESSION_UUID = "0192d4a8-7c1e-7a00-8000-00000000c0de";
/** The agent tachoSession records. */
const AGENT = "acme.core.cc-laptop";
const REMEMBER = "mcp__oxagen__remember_lesson";
const REFLECT = "mcp__oxagen__record_reflection";

const DAY_MS = 86_400_000;
const DAY1 = new Date("2026-09-27T06:00:00.000Z");
const DAY2 = new Date("2026-09-28T06:00:00.000Z");
const DAY3 = new Date("2026-09-29T06:00:00.000Z");
const DAY4 = new Date("2026-09-30T06:00:00.000Z");
const MERGED_AT = new Date("2026-09-27T08:00:00.000Z");
const BRANCH = "memory/2026-09-27";

function daysBefore(at: Date, days: number): Date {
  return new Date(at.getTime() - days * DAY_MS);
}

function hoursAfter(at: Date, hours: number): Date {
  return new Date(at.getTime() + hours * 3_600_000);
}

/** The memory record the fixture steering repo holds. */
const CACHE_PATH = "steering/memory/platform/a-intel.platform.ci-cache-key.md";
const CACHE_LINEAGE = "a-intel.platform.ci-cache-key";
/** The cache record's body on one line: the same words. */
const SAID =
  "The CI cache key hashes `pnpm-lock.yaml`. A run that changes dependencies without updating the lockfile restores a stale cache and fails typecheck.";
/** The cache record turned around: 16 of 18 words shared, and it negates. */
const CONTRADICTING =
  "The CI cache key does not hash `pnpm-lock.yaml`, so a run that changes dependencies without updating the lockfile does not restore a stale cache or fail typecheck.";
const STATEMENT =
  "Run pnpm install --frozen-lockfile before the first build in a fresh worktree.";
const PLANNED_PATH = memoryRecordPath(
  null,
  null,
  null,
  memoryLineage(STATEMENT, new Set()),
);

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected at least one item");
  return item;
}

// ── Frames ──────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
/** A body the fake evidence store holds, and the columns a frame names it by. */
function stored(text: string) {
  const bytes = enc.encode(text);
  const digest = digestBytes(bytes);
  const ref = `evb:v1:k:${digest.slice(7)}`;
  objects.set(ref, { bytes, contentType: "text/plain" });
  return { contentDigest: digest, bytesRef: ref };
}

const blank = { toolName: "", toolStatus: "", toolUseId: "" };

function prompt(seq: number, text: string, turnSeq = 1): TachoFrameRow {
  return tachoRow(seq, {
    kind: "turn_start",
    ...blank,
    turnSeq,
    ...stored(text),
  });
}

function call(
  seq: number,
  toolName: string,
  over: Partial<TachoFrameRow> = {},
): TachoFrameRow {
  return tachoRow(seq, { kind: "tool_call", toolName, turnSeq: 1, ...over });
}

/** One prompt and one tool call that worked: a run with no signal. */
const FIRST_TRY: TachoFrameRow[] = [prompt(0, "Fix the build."), call(1, "Read")];
/** One prompt and one failed Bash call. */
const FAILED_BUILD: TachoFrameRow[] = [
  prompt(0, "Fix the build."),
  call(1, "Bash", { toolStatus: "error" }),
];

// ── The memory store ────────────────────────────────────────────────────────

type StoredReflection = ReflectionDraft & { id: string; createdAt: Date };
type StoredPr = OpenMemoryPr & { status: "open" | "merged" | "closed" };

/** The five memory tables in memory, with store.ts's rules. */
class FakeMemoryStore implements MemoryStore {
  /** The time every insert is stamped with. */
  now = new Date("2026-09-27T05:00:00.000Z");
  memories: StoredMemory[] = [];
  reflections: StoredReflection[] = [];
  prs: StoredPr[] = [];
  rejections: Rejection[] = [];
  recalls = new Map<string, RecallStamp>();
  private ids = { memory: 0, reflection: 0, pr: 0 };

  async listCurateWorkspaces(): Promise<MemoryScope[]> {
    const busy =
      this.memories.some((m) => m.memoryPrId === null) ||
      this.prs.some((pr) => pr.status === "open") ||
      this.recalls.size > 0;
    return busy ? [SCOPE] : [];
  }

  async insertReflection(
    scope: MemoryScope,
    draft: ReflectionDraft,
    lessons: MemoryDraft[] = [],
  ): Promise<string | null> {
    if (this.reflections.some((r) => r.runPublicId === draft.runPublicId))
      return null;
    this.ids.reflection += 1;
    const id = `rfl-uuid-${this.ids.reflection}`;
    this.reflections.push({ ...draft, id, createdAt: this.now });
    await this.insertMemories(scope, lessons, id);
    return id;
  }

  async hasReflection(_scope: MemoryScope, runPublicId: string): Promise<boolean> {
    return this.reflections.some((r) => r.runPublicId === runPublicId);
  }

  async insertMemories(
    _scope: MemoryScope,
    drafts: MemoryDraft[],
    reflectionId?: string | null,
  ): Promise<number> {
    let written = 0;
    for (const draft of drafts) {
      if (this.memories.some((m) => m.dedupeKey === draft.dedupeKey)) continue;
      this.ids.memory += 1;
      this.memories.push({
        ...draft,
        id: `mem-uuid-${this.ids.memory}`,
        publicId: `mem_${this.ids.memory}`,
        reflectionId: reflectionId ?? null,
        memoryPrId: null,
        createdAt: this.now,
      });
      written += 1;
    }
    return written;
  }

  async countWaiting(_scope: MemoryScope): Promise<number> {
    return this.memories.filter((m) => m.memoryPrId === null).length;
  }

  async listWaiting(_scope: MemoryScope): Promise<StoredMemory[]> {
    return this.memories
      .filter((m) => m.memoryPrId === null)
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          Number(a.id > b.id) - Number(a.id < b.id),
      );
  }

  async deleteMemories(_scope: MemoryScope, ids: string[]): Promise<number> {
    const gone = new Set(ids);
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => !gone.has(m.id));
    return before - this.memories.length;
  }

  async listOpenPrs(_scope: MemoryScope): Promise<OpenMemoryPr[]> {
    return this.prs
      .filter((pr) => pr.status === "open")
      .map(({ status: _status, ...pr }) => pr);
  }

  async openedPrFrom(_scope: MemoryScope, branch: string): Promise<boolean> {
    return this.prs.some((pr) => pr.branch === branch);
  }

  async insertMemoryPr(
    _scope: MemoryScope,
    pr: Omit<OpenMemoryPr, "id" | "openedAt">,
  ): Promise<string> {
    this.ids.pr += 1;
    const id = `mpr-uuid-${this.ids.pr}`;
    this.prs.push({ ...pr, id, openedAt: this.now, status: "open" });
    const cited = new Set(pr.records.flatMap((record) => record.memoryIds));
    for (const memory of this.memories)
      if (cited.has(memory.id)) memory.memoryPrId = id;
    return id;
  }

  async settlePr(_scope: MemoryScope, settlement: PrSettlement): Promise<void> {
    const pr = this.prs.find(
      (row) => row.id === settlement.prId && row.status === "open",
    );
    if (pr === undefined) return;
    pr.status = settlement.status;
    await this.deleteMemories(SCOPE, settlement.purgeMemoryIds);
    for (const hash of new Set(settlement.rejectedHashes)) {
      this.rejections = this.rejections.filter((r) => r.statementHash !== hash);
      this.rejections.push({ statementHash: hash, rejectedAt: settlement.settledAt });
    }
    this.stamp(
      [...settlement.mergedLineages, ...settlement.reviewedLineages],
      settlement.settledAt,
    );
  }

  async listRejections(_scope: MemoryScope): Promise<Rejection[]> {
    return [...this.rejections].sort(
      (a, b) => a.rejectedAt.getTime() - b.rejectedAt.getTime(),
    );
  }

  async listRecalls(_scope: MemoryScope): Promise<RecallStamp[]> {
    return [...this.recalls.values()].sort(
      (a, b) => Number(a.lineage > b.lineage) - Number(a.lineage < b.lineage),
    );
  }

  async stampRecalls(
    _scope: MemoryScope,
    lineages: string[],
    at: Date,
  ): Promise<void> {
    this.stamp(lineages, at);
  }

  async bumpRecalls(
    _scope: MemoryScope,
    lineages: string[],
    at: Date,
  ): Promise<void> {
    for (const lineage of new Set(lineages)) {
      const row = this.recalls.get(lineage);
      this.recalls.set(
        lineage,
        row === undefined
          ? { lineage, recallCount: 1, lastRecalledAt: at, reviewedAt: at }
          : { ...row, recallCount: row.recallCount + 1, lastRecalledAt: at },
      );
    }
  }

  async listReflectionsSince(
    _scope: MemoryScope,
    since: Date,
  ): Promise<RecentReflection[]> {
    return this.reflections
      .filter((r) => r.createdAt.getTime() >= since.getTime())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => ({
        createdAt: r.createdAt,
        lessons: r.lessons.map((lesson) => ({ statement: lesson.statement })),
      }));
  }

  /** A new row starts with no recalls, and an existing row keeps its count. */
  private stamp(lineages: string[], at: Date): void {
    for (const lineage of new Set(lineages)) {
      const row = this.recalls.get(lineage);
      this.recalls.set(lineage, {
        lineage,
        recallCount: row?.recallCount ?? 0,
        lastRecalledAt: at,
        reviewedAt: at,
      });
    }
  }
}

/** A memory the agent kept in the fixture run. */
function draft(statement: string, over: Partial<MemoryDraft> = {}): MemoryDraft {
  const hash = statementHash(statement);
  return {
    agentLineage: AGENT,
    runPublicId: TACHO_ID,
    capture: "remember",
    statement,
    statementHash: hash,
    kind: "memory",
    repos: null,
    appliesTo: null,
    tools: null,
    evidence: [`frame:${TACHO_ID}/1`],
    source: null,
    dedupeKey: `${TACHO_ID}:${hash}`,
    ...over,
  };
}

function reflection(runPublicId: string, statements: string[] = []): ReflectionDraft {
  return {
    runPublicId,
    agentLineage: AGENT,
    source: "agent",
    outcome: "completed",
    summary: "Fixed the build.",
    grades: { work: 4, tools: {} },
    lessons: statements.map((statement) => ({
      statement,
      kind: "memory",
      evidence: [],
    })),
    toolFeedback: [],
  };
}

// ── The harness ─────────────────────────────────────────────────────────────

const DIGEST_LESSON = "Use pnpm, not npm, to build this repository.";

/** The fast tier's answer: one lesson cites this run, and one cites another. */
const ANSWER: DigestReflection = {
  outcome: "failed",
  summary: "The agent ran the build with npm, and the build failed.",
  grades: { work: 2, tools: { Bash: 3, mcp__github__create_pr: 4 } },
  lessons: [
    {
      statement: DIGEST_LESSON,
      kind: "memory",
      evidence: [`frame:${TACHO_ID}/1`, "frame:tse_other/1"],
    },
    {
      statement: "A lesson that cites only another run.",
      kind: "memory",
      evidence: ["frame:tse_other/2"],
    },
  ],
  tool_feedback: [],
};

/** The fixture steering repo on main, plus any `main:<path>` files given. */
function steeringRepo(extra: Record<string, string> = {}): FakeGitHub {
  const seed: Record<string, string> = {};
  for (const [path, text] of fixtureRepo()) seed[`main:${path}`] = text;
  return new FakeGitHub({ ...seed, ...extra });
}

interface Over {
  rows?: TachoFrameRow[];
  session?: Parameters<typeof tachoSession>[0]["session"];
  store?: FakeMemoryStore;
  gh?: FakeGitHub;
  answer?: DigestReflection;
  enrichment?: boolean;
}

function harness(over: Over = {}) {
  const stores = memoryStores(
    [],
    [tachoSession({ publicId: TACHO_ID, session: over.session ?? {} })],
  );
  const store = over.store ?? new FakeMemoryStore();
  const gh = over.gh ?? steeringRepo();
  const generate = vi.fn<MemoryRunnerDeps["generate"]>(() =>
    Promise.resolve(over.answer ?? ANSWER),
  );
  const deps: MemoryRunnerDeps = {
    read: {
      queries: stores.queries,
      store: {
        getRunByPublicId: () => Promise.resolve(null),
        readAttemptEventsSince: memoryEvents([]),
      },
      readRunRollups: stores.readRunRollups,
      readWitnessFor: () => Promise.resolve(null),
      tachoFrames: memoryTachoFrames(SESSION_UUID, over.rows ?? FIRST_TRY),
    },
    bodies: {
      getBody: (_scope, ref) => {
        const object = objects.get(ref);
        if (!object) return Promise.reject(new Error(`no object for ${ref}`));
        return Promise.resolve({ ...object, digestHex: ref.slice(-64) });
      },
    },
    store,
    host: gh,
    generate,
    enrichmentEnabled: () => Promise.resolve(over.enrichment ?? true),
  };
  return { deps, store, gh, generate };
}

// ── Capture ─────────────────────────────────────────────────────────────────

const REMEMBERED = "Pin pnpm to the version in packageManager before a build.";
const LESSON = "Read the lockfile before you change a dependency.";

/** A remember_lesson call, a Read, and a record_reflection call. */
const RECORDED: TachoFrameRow[] = [
  prompt(0, "Fix the build."),
  call(1, REMEMBER, {
    ...stored(
      JSON.stringify({
        input: { statement: REMEMBERED },
        output: { status: "noted", message: "Noted." },
      }),
    ),
  }),
  call(2, "Read"),
  call(3, REFLECT, {
    ...stored(
      JSON.stringify({
        outcome: "completed",
        summary: "Pinned pnpm and fixed the build.",
        grades: { work: 4, tools: { [REMEMBER]: 5, Bash: 2 } },
        lessons: [{ statement: LESSON, evidence: [2, 2] }],
        tool_feedback: [
          { tool: "Bash", problem: "The output was cut off." },
          {
            tool: "mcp__github__create_pr",
            problem: "The description does not say which base branch it uses.",
          },
        ],
      }),
    ),
  }),
];

describe("captureMemories", () => {
  it("stores a remembered lesson, the reflection, and the reflection's lessons", async () => {
    const { deps, store } = harness({ rows: RECORDED });
    const out = await captureMemories(deps, SCOPE, TACHO_ID);
    expect(out).toEqual({
      outcome: "captured",
      memories: 2,
      reflected: true,
      digest: false,
      waiting: 2,
    });

    // Tool grades and feedback keep only tools a server owns, keyed
    // <server>__<tool>. Bash has no server.
    const kept = first(store.reflections);
    expect(kept).toMatchObject({
      id: "rfl-uuid-1",
      runPublicId: TACHO_ID,
      agentLineage: AGENT,
      source: "agent",
      outcome: "completed",
      summary: "Pinned pnpm and fixed the build.",
      grades: { work: 4, tools: { oxagen__remember_lesson: 5 } },
      toolFeedback: [
        {
          tool: "github__create_pr",
          problem: "The description does not say which base branch it uses.",
        },
      ],
    });
    expect(kept.lessons).toEqual([
      { statement: LESSON, kind: "memory", evidence: [`frame:${TACHO_ID}/2`] },
    ]);

    // The remembered lesson cites its own call, and carries no reflection.
    // The reflection's lesson carries the reflection's id.
    expect(store.memories).toEqual([
      expect.objectContaining({
        statement: REMEMBERED,
        capture: "remember",
        agentLineage: AGENT,
        runPublicId: TACHO_ID,
        evidence: [`frame:${TACHO_ID}/1`],
        reflectionId: null,
        dedupeKey: `${TACHO_ID}:${statementHash(REMEMBERED)}`,
      }),
      expect.objectContaining({
        statement: LESSON,
        evidence: [`frame:${TACHO_ID}/2`],
        reflectionId: "rfl-uuid-1",
        dedupeKey: `${TACHO_ID}:${statementHash(LESSON)}`,
      }),
    ]);
  });

  it("writes nothing twice when the capture runs again", async () => {
    const { deps, store } = harness({ rows: RECORDED });
    await captureMemories(deps, SCOPE, TACHO_ID);
    const again = await captureMemories(deps, SCOPE, TACHO_ID);
    expect(again).toEqual({
      outcome: "captured",
      memories: 0,
      reflected: true,
      digest: false,
      waiting: 2,
    });
    expect(store.reflections).toHaveLength(1);
    expect(store.memories).toHaveLength(2);
  });

  it("reads the input from the request frame when the call has a request and a result", async () => {
    const { deps, store } = harness({
      rows: [
        prompt(0, "Fix the build."),
        tachoRow(1, {
          kind: "tool_requested",
          toolName: REMEMBER,
          toolUseId: "tu_pair",
          turnSeq: 1,
          ...stored(JSON.stringify({ statement: REMEMBERED })),
        }),
        call(2, REMEMBER, { toolUseId: "tu_pair" }),
      ],
    });
    const out = await captureMemories(deps, SCOPE, TACHO_ID);
    expect(out).toMatchObject({ memories: 1, reflected: false, digest: false });
    expect(first(store.memories).evidence).toEqual([`frame:${TACHO_ID}/1`]);
  });

  it("skips a failed call, an unfinished call, and an input the tool refuses", async () => {
    const { deps, store } = harness({
      rows: [
        prompt(0, "Fix the build."),
        call(1, REMEMBER, {
          toolStatus: "error",
          ...stored(JSON.stringify({ statement: "A lesson from a failed call." })),
        }),
        tachoRow(2, {
          kind: "tool_requested",
          toolName: REMEMBER,
          toolUseId: "tu_unfinished",
          turnSeq: 1,
          ...stored(JSON.stringify({ statement: "A lesson that never ran." })),
        }),
        call(3, REMEMBER, { ...stored("remember this") }),
        call(4, REMEMBER, { ...stored(JSON.stringify({ statement: "   " })) }),
        call(5, REMEMBER),
      ],
    });
    const out = await captureMemories(deps, SCOPE, TACHO_ID);
    // The failed call is a signal, and the run holds no reflection.
    expect(out).toEqual({
      outcome: "captured",
      memories: 0,
      reflected: false,
      digest: true,
      waiting: 0,
    });
    expect(store.memories).toEqual([]);
  });

  it("asks for no digest when the run already has a reflection", async () => {
    const store = new FakeMemoryStore();
    await store.insertReflection(SCOPE, reflection(TACHO_ID));
    const { deps } = harness({ rows: FAILED_BUILD, store });
    const out = await captureMemories(deps, SCOPE, TACHO_ID);
    expect(out.digest).toBe(false);
  });

  it("reports a run it cannot find, and a run that is still live", async () => {
    const none = {
      memories: 0,
      reflected: false,
      digest: false,
      waiting: 0,
    };
    const { deps } = harness();
    expect(
      await captureMemories(deps, SCOPE, "tse_2b2b2b2b2b2b2b2b2b2b2b"),
    ).toEqual({ outcome: "not_found", ...none });
    expect(
      await captureMemories(deps, SCOPE, "arun_2b2b2b2b2b2b2b2b2b2b2b"),
    ).toEqual({ outcome: "not_found", ...none });

    const live = harness({
      rows: RECORDED,
      session: { outcome: "running", sealedAt: null },
    });
    expect(await captureMemories(live.deps, SCOPE, TACHO_ID)).toEqual({
      outcome: "live",
      ...none,
    });
    expect(live.store.memories).toEqual([]);
  });
});

// ── The digest ──────────────────────────────────────────────────────────────

describe("digestRun", () => {
  it("writes a reflection from the fast tier and keeps lessons that cite this run", async () => {
    const { deps, store, generate } = harness({ rows: FAILED_BUILD });
    expect(await digestRun(deps, SCOPE, TACHO_ID)).toBe("written");

    expect(generate).toHaveBeenCalledTimes(1);
    const [scope, ask] = first(generate.mock.calls);
    expect(scope).toBe(SCOPE);
    expect(ask.prompt).toContain(`Run ${TACHO_ID} showed a failed tool call.`);
    expect(ask.prompt).toContain(`frame:${TACHO_ID}/0 prompt "Fix the build."`);
    expect(ask.prompt).toContain(`frame:${TACHO_ID}/1 tool Bash failed`);

    // The lesson keeps only the evidence from this run. The lesson that cites
    // only another run is dropped.
    const kept = first(store.reflections);
    expect(kept).toMatchObject({
      runPublicId: TACHO_ID,
      agentLineage: AGENT,
      source: "digest",
      outcome: "failed",
      grades: { work: 2, tools: { github__create_pr: 4 } },
      toolFeedback: [],
    });
    expect(kept.lessons).toEqual([
      {
        statement: DIGEST_LESSON,
        kind: "memory",
        evidence: [`frame:${TACHO_ID}/1`],
      },
    ]);
    expect(store.memories).toEqual([
      expect.objectContaining({
        statement: DIGEST_LESSON,
        capture: "remember",
        agentLineage: AGENT,
        evidence: [`frame:${TACHO_ID}/1`],
        reflectionId: "rfl-uuid-1",
        dedupeKey: `${TACHO_ID}:${statementHash(DIGEST_LESSON)}`,
      }),
    ]);

    expect(await digestRun(deps, SCOPE, TACHO_ID)).toBe("exists");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("names a correction from the person as the signal", async () => {
    const { deps, generate } = harness({
      rows: [
        prompt(0, "Fix the build."),
        call(1, "Read"),
        prompt(2, "No, use pnpm instead.", 2),
      ],
    });
    expect(await digestRun(deps, SCOPE, TACHO_ID)).toBe("written");
    const [, ask] = first(generate.mock.calls);
    expect(ask.prompt).toContain(
      `Run ${TACHO_ID} showed a correction from the person.`,
    );
  });

  it("asks the fast tier nothing when enrichment is off", async () => {
    const { deps, generate } = harness({ rows: FAILED_BUILD, enrichment: false });
    expect(await digestRun(deps, SCOPE, TACHO_ID)).toBe("disabled");
    expect(generate).not.toHaveBeenCalled();
  });

  it("reports a run it cannot find, or one that is still live, as not found", async () => {
    const { deps, generate } = harness({ rows: FAILED_BUILD });
    expect(await digestRun(deps, SCOPE, "tse_2b2b2b2b2b2b2b2b2b2b2b")).toBe(
      "not_found",
    );
    const live = harness({
      rows: FAILED_BUILD,
      session: { outcome: "running", sealedAt: null },
    });
    expect(await digestRun(live.deps, SCOPE, TACHO_ID)).toBe("not_found");
    expect(generate).not.toHaveBeenCalled();
    expect(live.generate).not.toHaveBeenCalled();
  });

  it("asks nothing for a run with no signal", async () => {
    const { deps, generate, store } = harness({ rows: FIRST_TRY });
    expect(await digestRun(deps, SCOPE, TACHO_ID)).toBe("no_signal");
    expect(generate).not.toHaveBeenCalled();
    expect(store.reflections).toEqual([]);
  });

  it("asks nothing for a run that already has a reflection", async () => {
    const store = new FakeMemoryStore();
    await store.insertReflection(SCOPE, reflection(TACHO_ID));
    const { deps, generate } = harness({ rows: FAILED_BUILD, store });
    expect(await digestRun(deps, SCOPE, TACHO_ID)).toBe("exists");
    expect(generate).not.toHaveBeenCalled();
  });

  it("stores no lessons when another writer stored the reflection first", async () => {
    const store = new FakeMemoryStore();
    await store.insertReflection(SCOPE, reflection(TACHO_ID));
    vi.spyOn(store, "hasReflection").mockResolvedValue(false);
    const { deps, generate } = harness({ rows: FAILED_BUILD, store });
    expect(await digestRun(deps, SCOPE, TACHO_ID)).toBe("exists");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.reflections).toHaveLength(1);
    expect(store.memories).toEqual([]);
  });
});

// ── The curator ─────────────────────────────────────────────────────────────

/** Day one's memory PR, opened from one waiting memory. */
async function openedMemoryPr() {
  const h = harness();
  await h.store.insertMemories(SCOPE, [draft(STATEMENT)]);
  const out = await curateMemories(h.deps, SCOPE, DAY1);
  return { ...h, out, pull: first(h.gh.pulls) };
}

describe("curateMemories", () => {
  it("does nothing in a workspace with no memories, memory PRs, or recall rows", async () => {
    const { deps } = harness();
    expect(await curateMemories(deps, SCOPE, DAY1)).toEqual({
      outcome: "idle",
      settled: 0,
      dropped: 0,
      pullRequest: null,
    });
  });

  it("stops when the workspace has no steering repository", async () => {
    const { deps, store, gh } = harness();
    await store.insertMemories(SCOPE, [draft(STATEMENT)]);
    gh.repository = null;
    expect(await curateMemories(deps, SCOPE, DAY1)).toMatchObject({
      outcome: "no_repository",
      pullRequest: null,
    });
  });

  it.each([
    ["has no governance.toml", () => new FakeGitHub()],
    [
      "has a governance.toml that does not read",
      () => steeringRepo({ "main:steering/governance.toml": "mode = [" }),
    ],
  ])("stops when the steering repository %s", async (_name, repo) => {
    const { deps, store, gh } = harness({ gh: repo() });
    await store.insertMemories(SCOPE, [draft(STATEMENT)]);
    expect(await curateMemories(deps, SCOPE, DAY1)).toMatchObject({
      outcome: "no_governance",
      pullRequest: null,
    });
    expect(gh.pulls).toEqual([]);
  });

  it("opens the day's memory PR from a waiting memory", async () => {
    const { out, pull, gh, store } = await openedMemoryPr();
    expect(out).toEqual({
      outcome: "curated",
      settled: 0,
      dropped: 0,
      pullRequest: {
        number: pull.number,
        url: `https://github.com/a-intel/platform/pull/${pull.number}`,
      },
    });
    expect(pull).toMatchObject({
      title: "Memory PR 2026-09-27",
      head: BRANCH,
      base: REPO.defaultBranch,
      labels: OXAGEN_PR_LABELS,
    });
    expect(pull.body).toContain(
      "It proposes 1 steering record and archives 0 records.",
    );
    expect(pull.body).toContain(
      `- \`${PLANNED_PATH}\`. It cites 1 memory from 1 run.`,
    );
    expect(pull.body).toContain(`  > ${STATEMENT}`);

    // One commit on today's branch, on the main head the plan read.
    const stamp = first(gh.stamps);
    expect(stamp).toMatchObject({
      branch: BRANCH,
      parent: "base0",
      message: "Memory PR 2026-09-27",
    });
    expect(stamp.files.map((file) => file.path)).toEqual([PLANNED_PATH]);
    expect(first(stamp.files).content).toContain(STATEMENT);
    expect(first(stamp.files).content).toContain(`oxagen:run/${TACHO_ID}`);

    // The fixture's memory record had no recall row, so its stale clock
    // starts now.
    expect(store.recalls.get(CACHE_LINEAGE)).toEqual({
      lineage: CACHE_LINEAGE,
      recallCount: 0,
      lastRecalledAt: DAY1,
      reviewedAt: DAY1,
    });

    const memory = first(store.memories);
    const opened = first(store.prs);
    expect(opened).toMatchObject({
      provider: "github",
      repository: REPO.fullName,
      branch: BRANCH,
      number: pull.number,
      status: "open",
    });
    expect(opened.records).toEqual([
      {
        action: "propose",
        lineage: memoryLineage(STATEMENT, new Set()),
        path: PLANNED_PATH,
        kind: "memory",
        memoryIds: [memory.id],
        statementHashes: [statementHash(STATEMENT)],
      },
    ]);
    expect(memory.memoryPrId).toBe(opened.id);
  });

  it("opens one memory PR a day", async () => {
    const { deps, gh } = await openedMemoryPr();
    expect(await curateMemories(deps, SCOPE, hoursAfter(DAY1, 1))).toEqual({
      outcome: "opened_today",
      settled: 0,
      dropped: 0,
      pullRequest: null,
    });
    expect(gh.pulls).toHaveLength(1);
  });

  it("drops a memory a record already says and a memory that waited too long", async () => {
    const { deps, store, gh } = harness();
    await store.insertMemories(SCOPE, [draft(SAID)]);
    store.now = daysBefore(DAY1, 200);
    await store.insertMemories(SCOPE, [
      draft(STATEMENT, { runPublicId: "tse_old", dedupeKey: "tse_old:x" }),
    ]);
    expect(await curateMemories(deps, SCOPE, DAY1)).toEqual({
      outcome: "curated",
      settled: 0,
      dropped: 2,
      pullRequest: null,
    });
    expect(store.memories).toEqual([]);
    expect(gh.stamps).toEqual([]);
  });

  it("leaves out a record whose path already holds a file", async () => {
    const { deps, store, gh } = harness({
      gh: steeringRepo({ [`main:${PLANNED_PATH}`]: "not a record" }),
    });
    await store.insertMemories(SCOPE, [draft(STATEMENT)]);
    expect(await curateMemories(deps, SCOPE, DAY1)).toEqual({
      outcome: "curated",
      settled: 0,
      dropped: 0,
      pullRequest: null,
    });
    expect(gh.pulls).toEqual([]);
    expect(first(store.memories).memoryPrId).toBeNull();
  });

  it("replaces a branch a failed pass left with no PR", async () => {
    const { deps, store, gh } = harness();
    gh.commit(BRANCH, "steering/memory/left-over.md", "left over");
    await store.insertMemories(SCOPE, [draft(STATEMENT)]);
    const out = await curateMemories(deps, SCOPE, DAY1);
    expect(out.pullRequest).not.toBeNull();
    expect(gh.deletedBranches).toEqual([BRANCH]);
    expect(first(gh.stamps).parent).toBe("base0");
  });

  it("leaves today's branch alone when it has an open PR the ledger does not hold", async () => {
    const { deps, store, gh } = harness();
    gh.commit(BRANCH, "steering/memory/by-hand.md", "by hand");
    await gh.openPullRequest(REPO, {
      title: "A memory PR opened by hand",
      head: BRANCH,
      base: REPO.defaultBranch,
      body: "",
    });
    await store.insertMemories(SCOPE, [draft(STATEMENT)]);
    expect(await curateMemories(deps, SCOPE, DAY1)).toEqual({
      outcome: "opened_today",
      settled: 0,
      dropped: 0,
      pullRequest: null,
    });
    expect(gh.stamps).toEqual([]);
    expect(gh.deletedBranches).toEqual([]);
    expect(store.prs).toEqual([]);
  });

  it("starts today's branch at the head it read when main moves first", async () => {
    const { deps, store, gh } = harness();
    const ensure = gh.ensureBranch.bind(gh);
    vi.spyOn(gh, "ensureBranch").mockImplementation((...args) => {
      gh.commit(REPO.defaultBranch, "steering/memory/moved.md", "moved");
      return ensure(...args);
    });
    await store.insertMemories(SCOPE, [draft(STATEMENT)]);
    const out = await curateMemories(deps, SCOPE, DAY1);
    expect(out.pullRequest).not.toBeNull();
    expect(gh.resets).toEqual([]);
    expect(first(gh.stamps).parent).toBe("base0");
  });

  it("settles a merged memory PR and stamps the merged record at the merge", async () => {
    const { deps, store, gh, pull } = await openedMemoryPr();
    gh.clock = () => MERGED_AT;
    gh.mergeOnHost(pull.number);
    expect(await curateMemories(deps, SCOPE, DAY2)).toEqual({
      outcome: "curated",
      settled: 1,
      dropped: 0,
      pullRequest: null,
    });
    expect(first(store.prs).status).toBe("merged");
    expect(store.memories).toEqual([]);
    expect(store.rejections).toEqual([]);
    expect(gh.deletedBranches).toEqual([BRANCH]);
    const lineage = memoryLineage(STATEMENT, new Set());
    expect(store.recalls.get(lineage)).toEqual({
      lineage,
      recallCount: 0,
      lastRecalledAt: MERGED_AT,
      reviewedAt: MERGED_AT,
    });
  });

  it("rejects a record the reviewer deleted before the merge", async () => {
    const { deps, store, gh, pull } = await openedMemoryPr();
    gh.remove(BRANCH, PLANNED_PATH);
    gh.clock = () => MERGED_AT;
    gh.mergeOnHost(pull.number);
    expect(await curateMemories(deps, SCOPE, DAY2)).toMatchObject({
      outcome: "curated",
      settled: 1,
    });
    expect(store.rejections).toEqual([
      { statementHash: statementHash(STATEMENT), rejectedAt: MERGED_AT },
    ]);
    expect(store.recalls.has(memoryLineage(STATEMENT, new Set()))).toBe(false);
    expect(store.memories).toEqual([]);
  });

  it("proposes a rejected statement again only after memories from 2 more runs repeat it", async () => {
    const { deps, store, gh, pull } = await openedMemoryPr();
    gh.closeOnHost(pull.number);
    expect(await curateMemories(deps, SCOPE, DAY2)).toEqual({
      outcome: "curated",
      settled: 1,
      dropped: 0,
      pullRequest: null,
    });
    expect(store.rejections).toEqual([
      { statementHash: statementHash(STATEMENT), rejectedAt: DAY2 },
    ]);
    expect(store.memories).toEqual([]);

    const repeat = (source: string) => ({
      capture: "local_gateway",
      source,
      statement: STATEMENT,
      agentLineage: null,
      runPublicId: null,
    });
    store.now = hoursAfter(DAY2, 1);
    await ingestMemories(store, SCOPE, [
      repeat("https://github.com/a-intel/platform/pull/7"),
    ]);
    expect(await curateMemories(deps, SCOPE, DAY3)).toMatchObject({
      outcome: "curated",
      pullRequest: null,
    });
    expect(gh.pulls).toHaveLength(1);

    store.now = hoursAfter(DAY3, 1);
    await ingestMemories(store, SCOPE, [
      repeat("https://github.com/a-intel/platform/pull/8"),
    ]);
    const out = await curateMemories(deps, SCOPE, DAY4);
    expect(out.pullRequest).not.toBeNull();
    const again = gh.pulls[1];
    expect(again?.head).toBe("memory/2026-09-30");
    expect(again?.body).toContain(
      `- \`${PLANNED_PATH}\`. It cites 2 memories with no run.`,
    );
  });

  it("archives a memory record no run recalled within retire_after_days", async () => {
    const { deps, store, gh } = harness();
    const last = daysBefore(DAY1, 200);
    store.recalls.set(CACHE_LINEAGE, {
      lineage: CACHE_LINEAGE,
      recallCount: 3,
      lastRecalledAt: last,
      reviewedAt: last,
    });
    const out = await curateMemories(deps, SCOPE, DAY1);
    expect(out.pullRequest).not.toBeNull();

    const pull = first(gh.pulls);
    expect(pull.body).toContain(
      "It proposes 0 steering records and archives 1 record.",
    );
    expect(pull.body).toContain(
      `- \`${CACHE_PATH}\`. No run recalled it within \`retire_after_days\`.`,
    );
    const file = first(first(gh.stamps).files);
    expect(file.path).toBe(CACHE_PATH);
    expect(file.content).toContain("status: archived");
    expect(first(store.prs).records).toEqual([
      {
        action: "retire",
        lineage: CACHE_LINEAGE,
        path: CACHE_PATH,
        kind: "memory",
        memoryIds: [],
        statementHashes: [],
      },
    ]);
  });

  it("archives a memory record a reflection contradicts after its last review", async () => {
    const { deps, store, gh } = harness();
    store.recalls.set(CACHE_LINEAGE, {
      lineage: CACHE_LINEAGE,
      recallCount: 1,
      lastRecalledAt: daysBefore(DAY1, 1),
      reviewedAt: daysBefore(DAY1, 10),
    });
    store.now = daysBefore(DAY1, 5);
    await store.insertReflection(SCOPE, reflection("tse_other", [CONTRADICTING]));
    const out = await curateMemories(deps, SCOPE, DAY1);
    expect(out.pullRequest).not.toBeNull();
    expect(first(gh.pulls).body).toContain(
      `- \`${CACHE_PATH}\`. A reflection written since its last review contradicts it.`,
    );
    expect(first(first(gh.stamps).files).content).toContain("status: archived");
  });

  it.each([
    [
      "is on a repository the workspace no longer uses",
      async (_gh: FakeGitHub) => ({ repository: "a-intel/other", number: 7 }),
    ],
    [
      "has a number the host does not know",
      async (_gh: FakeGitHub) => ({ repository: REPO.fullName, number: 999 }),
    ],
    [
      "merged with no merge commit yet",
      async (gh: FakeGitHub) => {
        const opened = await gh.openPullRequest(REPO, {
          title: "Memory PR 2026-09-20",
          head: "memory/2026-09-20",
          base: REPO.defaultBranch,
          body: "",
        });
        const pull = first(gh.pulls);
        Object.assign(pull, {
          state: "closed",
          merged: true,
          mergeCommitSha: null,
          mergedAt: DAY1,
        });
        return { repository: REPO.fullName, number: opened.number };
      },
    ],
  ])("keeps a memory PR open while it %s", async (_name, setup) => {
    const { deps, store, gh } = harness();
    const { repository, number } = await setup(gh);
    await store.insertMemoryPr(SCOPE, {
      provider: "github",
      repository,
      branch: "memory/2026-09-20",
      number,
      url: `https://github.com/${repository}/pull/${number}`,
      records: [],
    });
    expect(await curateMemories(deps, SCOPE, DAY1)).toMatchObject({
      outcome: "curated",
      settled: 0,
    });
    expect(first(store.prs).status).toBe("open");
  });
});

// ── Recall ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-27T05:00:00.000Z");
const RECALLED = "Run the migration generator after a schema edit.";

function activeRecord(
  over: Partial<ActiveRecord> & { lineage: string },
): ActiveRecord {
  return {
    path: `steering/memory/workspace/general/${over.lineage}.md`,
    kind: "memory",
    status: "active",
    statement: RECALLED,
    repos: null,
    appliesTo: null,
    tools: null,
    text: "",
    ...over,
  };
}

function request(over: Partial<RecallRequest> = {}): RecallRequest {
  return {
    now: NOW,
    agent: AGENT,
    inApp: false,
    repository: "github.com/a-intel/platform",
    tools: [],
    paths: [],
    text: RECALLED,
    recallUnreviewed: "same-agent",
    ...over,
  };
}

describe("recallMemories", () => {
  it("gives Oxagen's in-app agent nothing", async () => {
    const store = new FakeMemoryStore();
    const records = [activeRecord({ lineage: "migrate-after-schema-edit" })];
    expect(
      await recallMemories(store, SCOPE, request({ inApp: true }), records),
    ).toEqual([]);
    expect(store.recalls.size).toBe(0);
  });

  it("recalls only active records under steering/memory/ and counts each one it serves", async () => {
    const store = new FakeMemoryStore();
    const items = await recallMemories(store, SCOPE, request(), [
      activeRecord({ lineage: "migrate-after-schema-edit" }),
      activeRecord({ lineage: "archived-migrate", status: "archived" }),
      activeRecord({
        lineage: "rule-migrate",
        path: "steering/rules/rule-migrate.md",
      }),
    ]);
    expect(items).toEqual([
      {
        id: "migrate-after-schema-edit",
        source: "record",
        statement: RECALLED,
        score: 1,
        tokens: expect.any(Number),
      },
    ]);
    expect([...store.recalls.values()]).toEqual([
      {
        lineage: "migrate-after-schema-edit",
        recallCount: 1,
        lastRecalledAt: NOW,
        reviewedAt: NOW,
      },
    ]);
  });

  it("recalls a waiting memory only for the agent that kept it", async () => {
    const store = new FakeMemoryStore();
    store.now = NOW;
    await store.insertMemories(SCOPE, [
      draft(RECALLED),
      draft(RECALLED, {
        agentLineage: "acme.core.other-laptop",
        runPublicId: "tse_other",
        dedupeKey: `tse_other:${statementHash(RECALLED)}`,
      }),
    ]);
    const items = await recallMemories(store, SCOPE, request(), []);
    expect(items).toEqual([
      {
        id: "mem_1",
        source: "memory",
        statement: RECALLED,
        score: 1,
        tokens: expect.any(Number),
      },
    ]);
    expect(store.recalls.size).toBe(0);
  });

  it("reads no waiting memories when recall_unreviewed is off", async () => {
    const store = new FakeMemoryStore();
    store.now = NOW;
    await store.insertMemories(SCOPE, [draft(RECALLED)]);
    const listWaiting = vi.spyOn(store, "listWaiting");
    const items = await recallMemories(
      store,
      SCOPE,
      request({ recallUnreviewed: "off" }),
      [activeRecord({ lineage: "migrate-after-schema-edit" })],
    );
    expect(items.map((item) => item.id)).toEqual(["migrate-after-schema-edit"]);
    expect(listWaiting).not.toHaveBeenCalled();
  });

  it("ages a record from its last review and keeps that review time", async () => {
    const store = new FakeMemoryStore();
    const reviewed = daysBefore(NOW, 30);
    store.recalls.set("migrate-after-schema-edit", {
      lineage: "migrate-after-schema-edit",
      recallCount: 0,
      lastRecalledAt: reviewed,
      reviewedAt: reviewed,
    });
    const [item] = await recallMemories(store, SCOPE, request(), [
      activeRecord({ lineage: "migrate-after-schema-edit" }),
    ]);
    // One half-life of 30 days halves the weight.
    expect(item?.score).toBeCloseTo(0.5);
    expect(store.recalls.get("migrate-after-schema-edit")).toEqual({
      lineage: "migrate-after-schema-edit",
      recallCount: 1,
      lastRecalledAt: NOW,
      reviewedAt: reviewed,
    });
  });
});

// ── Memories from outside a run ─────────────────────────────────────────────

const PR_SOURCE = "https://github.com/a-intel/platform/pull/7";

describe("ingestMemories", () => {
  it("stores a memory from a pull request and one from the local gateway", async () => {
    const store = new FakeMemoryStore();
    const out = await ingestMemories(store, SCOPE, [
      {
        capture: "pull_request",
        source: PR_SOURCE,
        statement: STATEMENT,
        agentLineage: AGENT,
        runPublicId: TACHO_ID,
        evidence: [`${PR_SOURCE}#discussion_r1`],
      },
      {
        capture: "local_gateway",
        source: "gateway:laptop",
        statement: LESSON,
        agentLineage: null,
        runPublicId: null,
        repos: ["github.com/a-intel/platform"],
      },
    ]);
    expect(out).toEqual({ written: 2, refused: 0 });
    expect(store.memories).toEqual([
      expect.objectContaining({
        capture: "pull_request",
        source: PR_SOURCE,
        agentLineage: AGENT,
        runPublicId: TACHO_ID,
        kind: "memory",
        evidence: [`${PR_SOURCE}#discussion_r1`],
        dedupeKey: `pull_request:${PR_SOURCE}:${statementHash(STATEMENT)}`,
      }),
      expect.objectContaining({
        capture: "local_gateway",
        agentLineage: null,
        runPublicId: null,
        repos: ["github.com/a-intel/platform"],
        evidence: [],
        dedupeKey: `local_gateway:gateway:laptop:${statementHash(LESSON)}`,
      }),
    ]);
  });

  it("refuses a memory the intake schema does not accept", async () => {
    const store = new FakeMemoryStore();
    const insert = vi.spyOn(store, "insertMemories");
    const base = {
      capture: "pull_request",
      source: PR_SOURCE,
      statement: STATEMENT,
    };
    const out = await ingestMemories(store, SCOPE, [
      { ...base, agentLineage: AGENT, runPublicId: null },
      {
        ...base,
        capture: "local_gateway",
        agentLineage: null,
        runPublicId: TACHO_ID,
      },
      { ...base, agentLineage: null, runPublicId: null, extra: true },
      { ...base, agentLineage: AGENT, runPublicId: "run_123" },
    ]);
    expect(out).toEqual({ written: 0, refused: 4 });
    expect(insert).not.toHaveBeenCalled();
  });

  it("skips a memory it stored before", async () => {
    const store = new FakeMemoryStore();
    const input = {
      capture: "pull_request",
      source: PR_SOURCE,
      statement: STATEMENT,
      agentLineage: null,
      runPublicId: null,
    };
    await ingestMemories(store, SCOPE, [input]);
    expect(await ingestMemories(store, SCOPE, [input])).toEqual({
      written: 0,
      refused: 0,
    });
    expect(store.memories).toHaveLength(1);
  });
});

/** The default branch's head when the curator planned the PR. */
const PLANNED = "base0";

describe("prepareBranch", () => {
  beforeEach(() => vi.mocked(logger.warn).mockClear());

  it("creates today's branch at the head the plan read", async () => {
    const gh = new FakeGitHub();
    await expect(prepareBranch(gh, REPO, BRANCH, PLANNED)).resolves.toBe(true);
    expect(gh.heads.get(BRANCH)).toBe(PLANNED);
    expect(gh.resets).toEqual([]);
  });

  it("creates the branch at the planned head when the default branch moved after the plan", async () => {
    const gh = new FakeGitHub();
    gh.commit(REPO.defaultBranch, "steering/rules/new.md", "a merge");
    const branchHead = vi.spyOn(gh, "branchHead");
    await expect(prepareBranch(gh, REPO, BRANCH, PLANNED)).resolves.toBe(true);
    expect(gh.heads.get(BRANCH)).toBe(PLANNED);
    // The host creates the branch at the planned commit in one call, so the
    // curator never reads it back or moves it.
    expect(gh.resets).toEqual([]);
    expect(branchHead).not.toHaveBeenCalled();
  });

  it("recreates a failed pass's branch at the planned head when the default branch moved", async () => {
    const gh = new FakeGitHub();
    await gh.ensureBranch(REPO, BRANCH, REPO.defaultBranch);
    gh.commit(BRANCH, "steering/memory/half.md", "a pass that failed");
    gh.commit(REPO.defaultBranch, "steering/rules/new.md", "a merge");
    await expect(prepareBranch(gh, REPO, BRANCH, PLANNED)).resolves.toBe(true);
    expect(gh.deletedBranches).toEqual([BRANCH]);
    expect(gh.heads.get(BRANCH)).toBe(PLANNED);
    expect(gh.resets).toEqual([]);
  });

  it("replaces a branch a failed pass left without a PR", async () => {
    const gh = new FakeGitHub();
    await gh.ensureBranch(REPO, BRANCH, REPO.defaultBranch);
    gh.commit(BRANCH, "steering/memory/half.md", "a pass that failed");
    await expect(prepareBranch(gh, REPO, BRANCH, PLANNED)).resolves.toBe(true);
    expect(gh.deletedBranches).toEqual([BRANCH]);
    expect(gh.heads.get(BRANCH)).toBe(PLANNED);
  });

  it("leaves a branch that already has an open PR", async () => {
    const gh = new FakeGitHub();
    await gh.ensureBranch(REPO, BRANCH, REPO.defaultBranch);
    const theirs = gh.commit(BRANCH, "steering/memory/theirs.md", "their PR");
    await gh.openPullRequest(REPO, {
      title: "Their memories",
      head: BRANCH,
      base: REPO.defaultBranch,
      body: "",
    });
    await expect(prepareBranch(gh, REPO, BRANCH, PLANNED)).resolves.toBe(false);
    expect(gh.deletedBranches).toEqual([]);
    expect(gh.heads.get(BRANCH)).toBe(theirs);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ branch: BRANCH }),
      expect.stringContaining("has an open PR"),
    );
  });
});
