/**
 * Memory uses (`memory-uses.ts`): which tool calls read a memory file, how
 * reads in one run merge into one use, and what each control plane answer
 * does to the queue.
 */
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../../host/control-client";
import { createUseCountLedger, type UseCountLedger } from "./memory-counts";
import type {
  HarnessMemoryLocation,
  HarnessUseCounts,
  MemoryScan,
} from "./memory-reader";
import {
  claudeCodeMemoryLocations,
  HARNESS_MEMORY_LOCATIONS,
} from "./memory-reader";
import {
  createMemoryUses,
  MEMORY_COUNTS_PER_REPORT,
  MEMORY_SCAN_PATHS_MAX,
  MEMORY_USES_PATH,
  MEMORY_USES_PER_REPORT,
  MEMORY_USES_QUEUED_MAX,
  memoryFileOf,
  memoryReadsOf,
} from "./memory-uses";

const HOME = "/home/dev";
const PROJECTS = join(HOME, ".claude", "projects");
const FILE = join(PROJECTS, "-proj", "memory", "use-pnpm.md");
const INDEX = join(PROJECTS, "-proj", "memory", "MEMORY.md");
const HOST_ENROLLMENT_ID = "tch_0123456789abcdefghjkmn";
const RUN_A = "0b3f8a52-8d2c-4f0e-9a49-6f1c2d3e4a5b";
const RUN_B = "1c4f9b63-9e3d-4a1f-8b5a-7a2d3e4f5b6c";
const NOW = Date.parse("2026-10-01T12:00:00.000Z");

const reads = (
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd?: string,
) => memoryReadsOf(toolName, toolInput, cwd, HOME, HARNESS_MEMORY_LOCATIONS);

describe("a memory file", () => {
  it("is a file in a project's memory folder under the projects folder", () => {
    expect(memoryFileOf(FILE, HARNESS_MEMORY_LOCATIONS, HOME)).toEqual({
      harness: "claude-code",
      path: FILE,
    });
    // A path with `..` or doubled separators names the same file.
    expect(
      memoryFileOf(
        `${PROJECTS}/-proj/other/../memory//use-pnpm.md`,
        HARNESS_MEMORY_LOCATIONS,
        HOME,
      )?.path,
    ).toBe(FILE);
  });

  it("is never MEMORY.md, another extension, or a file outside a project's memory folder", () => {
    for (const path of [
      INDEX,
      join(PROJECTS, "-proj", "memory", "notes.txt"),
      join(PROJECTS, "-proj", "rule.md"),
      join(PROJECTS, "-proj", "memory", "deep", "rule.md"),
      join(PROJECTS, "memory", "rule.md"),
      join(HOME, "work", "-proj", "memory", "rule.md"),
      "memory/rule.md",
    ])
      expect(memoryFileOf(path, HARNESS_MEMORY_LOCATIONS, HOME), path).toBe(
        undefined,
      );
  });

  it("is a file in a subagent's folder, for the user or a project", () => {
    const user = join(HOME, ".claude", "agent-memory", "reviewer", "a.md");
    expect(memoryFileOf(user, HARNESS_MEMORY_LOCATIONS, HOME)).toEqual({
      harness: "claude-code",
      path: user,
    });
    const locations = claudeCodeMemoryLocations(join(HOME, ".claude"), [
      "/work/app",
    ]);
    for (const path of [
      "/work/app/.claude/agent-memory/planner/p.md",
      "/work/app/.claude/agent-memory-local/planner/l.md",
    ])
      expect(memoryFileOf(path, locations, HOME)?.path, path).toBe(path);
    for (const path of [
      join(HOME, ".claude", "agent-memory", "reviewer", "MEMORY.md"),
      join(HOME, ".claude", "agent-memory", "loose.md"),
      join(HOME, ".claude", "agent-memory", "reviewer", "deep", "b.md"),
      "/work/other/.claude/agent-memory/planner/p.md",
    ])
      expect(memoryFileOf(path, locations, HOME), path).toBeUndefined();
  });

  it("follows the projects folder its location names", () => {
    const moved: HarnessMemoryLocation[] = [
      { ...HARNESS_MEMORY_LOCATIONS[0]!, projectsDir: () => "/cfg/projects" },
    ];
    expect(
      memoryFileOf("/cfg/projects/-p/memory/a.md", moved, HOME)?.path,
    ).toBe("/cfg/projects/-p/memory/a.md");
    expect(memoryFileOf(FILE, moved, HOME)).toBeUndefined();
  });
});

describe("the memory files a tool call read", () => {
  it("counts a Read of a memory file and not of MEMORY.md", () => {
    expect(reads("Read", { file_path: FILE })).toEqual([
      { harness: "claude-code", path: FILE },
    ]);
    expect(reads("Read", { file_path: INDEX })).toEqual([]);
  });

  it("counts a Grep of one memory file, and not a Grep of the memory folder", () => {
    expect(reads("Grep", { pattern: "pnpm", path: FILE })).toEqual([
      { harness: "claude-code", path: FILE },
    ]);
    expect(
      reads("Grep", { pattern: "pnpm", path: join(PROJECTS, "-proj", "memory") }),
    ).toEqual([]);
  });

  it("finds memory files in a Bash command by home-relative, absolute, and relative paths", () => {
    expect(reads("Bash", { command: "cat ~/.claude/projects/-proj/memory/use-pnpm.md" })).toEqual([
      { harness: "claude-code", path: FILE },
    ]);
    expect(reads("Bash", { command: 'head -n 5 "$HOME/.claude/projects/-proj/memory/use-pnpm.md"' })).toEqual([
      { harness: "claude-code", path: FILE },
    ]);
    expect(reads("Bash", { command: "wc -l ${HOME}/.claude/projects/-proj/memory/use-pnpm.md" })).toEqual([
      { harness: "claude-code", path: FILE },
    ]);
    expect(reads("Bash", { command: `rg pnpm ${FILE}|head` })).toEqual([
      { harness: "claude-code", path: FILE },
    ]);
    expect(
      reads("Bash", { command: "cat memory/use-pnpm.md" }, join(PROJECTS, "-proj")),
    ).toEqual([{ harness: "claude-code", path: FILE }]);
  });

  it("names each file once, however often the command names it", () => {
    expect(
      reads("Bash", { command: `diff ${FILE} ~/.claude/projects/-proj/memory/use-pnpm.md` }),
    ).toEqual([{ harness: "claude-code", path: FILE }]);
  });

  it("finds nothing in a relative path without an absolute cwd, a glob, or another tool", () => {
    expect(reads("Bash", { command: "cat memory/use-pnpm.md" })).toEqual([]);
    expect(
      reads("Bash", { command: "cat ~/.claude/projects/-proj/memory/*.md" }),
    ).toEqual([]);
    expect(reads("Edit", { file_path: FILE })).toEqual([]);
    expect(reads("Write", { file_path: FILE })).toEqual([]);
    expect(memoryReadsOf(undefined, undefined, undefined, HOME, HARNESS_MEMORY_LOCATIONS)).toEqual([]);
  });
});

interface Call {
  url: string;
  authorization: string | undefined;
  body: {
    host_enrollment_id: string;
    uses?: Array<{
      harness: string;
      path: string;
      signal?: string;
      session_uuid: string;
      count: number;
      used_at: string;
    }>;
    scans?: MemoryScan[];
    counts?: Array<{
      harness: string;
      path: string;
      count: number;
      used_at: string;
    }>;
  };
}

/**
 * A control plane that answers each call with the next answer: a status, a
 * status with the `pending` indexes, or a thrown error.
 */
function plane(answers: Array<number | { pending: number[] } | Error> = []) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      authorization: init.headers["Authorization"],
      body: JSON.parse(init.body ?? "null") as Call["body"],
    });
    const answer = answers.shift() ?? 200;
    if (answer instanceof Error) throw answer;
    const status = typeof answer === "number" ? answer : 200;
    const pending = typeof answer === "number" ? [] : answer.pending;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () =>
        JSON.stringify({ recorded: 0, unknown: 0, pending, retired: 0 }),
    };
  };
  return { fetch, calls };
}

function uses(fetch: FetchLike, now = () => NOW, counts?: UseCountLedger) {
  const lines: string[] = [];
  const memoryUses = createMemoryUses({
    host: () => ({
      api_url: "https://api.oxagen.test/",
      api_key: "oxk_host",
      host_enrollment_id: HOST_ENROLLMENT_ID,
    }),
    fetch,
    log: (line) => lines.push(line),
    now,
    timeoutMs: 1_000,
    ...(counts !== undefined ? { counts } : {}),
  });
  return { memoryUses, lines };
}

const at = (ms: number) => new Date(ms).toISOString();

const SCAN: MemoryScan = {
  harness: "claude-code",
  root: `${PROJECTS}${sep}`,
  paths: [FILE],
};

describe("a report", () => {
  it("sends two reads of one file in one run as one use with a count of two", async () => {
    const { fetch, calls } = plane();
    const { memoryUses } = uses(fetch);
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_A, at: at(NOW - 2_000) });
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_A, at: at(NOW - 1_000) });
    expect(memoryUses.size()).toBe(1);
    await memoryUses.report();
    expect(calls).toEqual([
      {
        url: `https://api.oxagen.test${MEMORY_USES_PATH}`,
        authorization: "Bearer oxk_host",
        body: {
          host_enrollment_id: HOST_ENROLLMENT_ID,
          uses: [
            {
              harness: "claude-code",
              path: FILE,
              session_uuid: RUN_A,
              count: 2,
              used_at: at(NOW - 1_000),
            },
          ],
        },
      },
    ]);
    expect(memoryUses.size()).toBe(0);
  });

  it("sends a read in each of two runs as two uses", async () => {
    const { fetch, calls } = plane();
    const { memoryUses } = uses(fetch);
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_A, at: at(NOW) });
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_B, at: at(NOW) });
    await memoryUses.report();
    expect(calls[0]?.body.uses?.map((use) => use.session_uuid)).toEqual([
      RUN_A,
      RUN_B,
    ]);
  });

  it("sends nothing with nothing queued and no scan", async () => {
    const { fetch, calls } = plane();
    const { memoryUses } = uses(fetch);
    await memoryUses.report();
    await memoryUses.report([]);
    expect(calls).toEqual([]);
  });

  it("sends the uses in calls of at most 200, then the scans in a call of their own", async () => {
    const { fetch, calls } = plane();
    const { memoryUses } = uses(fetch);
    for (let i = 0; i < MEMORY_USES_PER_REPORT + 5; i += 1)
      memoryUses.note({
        harness: "claude-code",
        path: join(PROJECTS, "-proj", "memory", `m${i}.md`),
        sessionUuid: RUN_A,
        at: at(NOW),
      });
    await memoryUses.report([SCAN]);
    expect(calls.map((call) => call.body.uses?.length ?? 0)).toEqual([
      MEMORY_USES_PER_REPORT,
      5,
      0,
    ]);
    // A refused scan list never costs a use, so the list rides alone.
    expect(calls.map((call) => call.body.scans)).toEqual([
      undefined,
      undefined,
      [SCAN],
    ]);
  });

  it("sends a scan alone when no run read a memory", async () => {
    const { fetch, calls } = plane();
    const { memoryUses } = uses(fetch);
    await memoryUses.report([SCAN]);
    expect(calls.map((call) => call.body)).toEqual([
      { host_enrollment_id: HOST_ENROLLMENT_ID, scans: [SCAN] },
    ]);
  });

  it("does not send a scan that found more files than one report takes", async () => {
    const { fetch, calls } = plane();
    const { memoryUses, lines } = uses(fetch);
    const big: MemoryScan = {
      ...SCAN,
      paths: Array.from({ length: MEMORY_SCAN_PATHS_MAX + 1 }, (_, i) =>
        join(PROJECTS, "-proj", "memory", `m${i}.md`),
      ),
    };
    await memoryUses.report([big]);
    await memoryUses.report([big]);
    expect(calls).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it("keeps a pending use for the next report and drops the rest", async () => {
    const { fetch, calls } = plane([{ pending: [1] }, 200]);
    const { memoryUses } = uses(fetch);
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_A, at: at(NOW) });
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_B, at: at(NOW) });
    await memoryUses.report();
    expect(memoryUses.size()).toBe(1);
    // A read noted since merges with the pending use.
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_B, at: at(NOW + 1_000) });
    await memoryUses.report();
    expect(calls[1]?.body.uses).toEqual([
      {
        harness: "claude-code",
        path: FILE,
        session_uuid: RUN_B,
        count: 2,
        used_at: at(NOW + 1_000),
      },
    ]);
    expect(memoryUses.size()).toBe(0);
  });

  it("drops a pending use a day old", async () => {
    const { fetch } = plane([{ pending: [0] }]);
    const { memoryUses } = uses(fetch);
    memoryUses.note({
      harness: "claude-code",
      path: FILE,
      sessionUuid: RUN_A,
      at: at(NOW - 25 * 60 * 60_000),
    });
    await memoryUses.report();
    expect(memoryUses.size()).toBe(0);
  });

  it("keeps the queue while the route is missing, and logs that once", async () => {
    const { fetch, calls } = plane([404, 404]);
    const { memoryUses, lines } = uses(fetch);
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_A, at: at(NOW) });
    await memoryUses.report([SCAN]);
    await memoryUses.report([SCAN]);
    // The scans wait behind the uses, so each report made one call.
    expect(calls).toHaveLength(2);
    expect(memoryUses.size()).toBe(1);
    expect(lines).toEqual([
      `memory uses: the control plane has no ${MEMORY_USES_PATH} route yet; the uses wait until it does`,
    ]);
  });

  it("keeps the queue when the control plane fails, and logs a failure when it changes", async () => {
    const { fetch } = plane([503, 503, new Error("ECONNREFUSED"), 200]);
    const { memoryUses, lines } = uses(fetch);
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_A, at: at(NOW) });
    await memoryUses.report();
    await memoryUses.report();
    await memoryUses.report();
    expect(memoryUses.size()).toBe(1);
    await memoryUses.report();
    expect(memoryUses.size()).toBe(0);
    expect(lines).toEqual([
      "memory uses: the control plane answered 503; the uses wait for the next report",
      "memory uses: the control plane is unreachable (ECONNREFUSED); the uses wait for the next report",
    ]);
  });

  it("drops the uses of a call the control plane refuses, and sends the next one", async () => {
    const { fetch, calls } = plane([422, 200]);
    const { memoryUses, lines } = uses(fetch);
    for (let i = 0; i < MEMORY_USES_PER_REPORT + 1; i += 1)
      memoryUses.note({
        harness: "claude-code",
        path: join(PROJECTS, "-proj", "memory", `m${i}.md`),
        sessionUuid: RUN_A,
        at: at(NOW),
      });
    await memoryUses.report();
    expect(calls).toHaveLength(2);
    expect(memoryUses.size()).toBe(0);
    expect(lines).toEqual([
      `memory uses: the control plane refused ${MEMORY_USES_PER_REPORT} uses (422); they are dropped`,
    ]);
  });

  it("joins a report still running rather than send twice", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      await gate;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const { memoryUses } = uses(fetch);
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_A, at: at(NOW) });
    const first = memoryUses.report();
    const second = memoryUses.report();
    expect(second).toBe(first);
    // A read noted while the call runs waits for the next report.
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_A, at: at(NOW + 1) });
    release();
    await first;
    expect(calls).toHaveLength(1);
    expect(memoryUses.size()).toBe(1);
  });
});

/** A ledger that keeps its counts in memory. */
function ledger() {
  let saved: string | undefined;
  return createUseCountLedger({
    storage: {
      load: () => (saved === undefined ? undefined : JSON.parse(saved)),
      save: (json) => {
        saved = json;
      },
    },
    log: () => {},
    now: () => NOW,
  });
}

const CODEX_SCAN: MemoryScan = {
  harness: "codex",
  root: "thread/",
  paths: ["thread/t1"],
};

/** A full read of the Codex store with these counts. */
function codexCounts(counts: Record<string, number>): HarnessUseCounts[] {
  return [
    {
      harness: "codex",
      root: "thread/",
      counts: Object.entries(counts).map(([thread, count]) => ({
        path: `thread/${thread}`,
        count,
        lastUsedAt: at(NOW - 60_000),
      })),
    },
  ];
}

describe("a report of harness counts", () => {
  it("sends the rise in each count after the uses and before the scans, each in a call of its own", async () => {
    const { fetch, calls } = plane();
    const { memoryUses } = uses(fetch, undefined, ledger());
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_A, at: at(NOW) });
    await memoryUses.report([CODEX_SCAN], codexCounts({ t1: 4, t2: 0 }));
    expect(calls.map((call) => Object.keys(call.body).sort())).toEqual([
      ["host_enrollment_id", "uses"],
      ["counts", "host_enrollment_id"],
      ["host_enrollment_id", "scans"],
    ]);
    expect(calls[1]?.body.counts).toEqual([
      { harness: "codex", path: "thread/t1", count: 4, used_at: at(NOW - 60_000) },
    ]);
  });

  it("sends only the rise since the last report that landed", async () => {
    const { fetch, calls } = plane();
    const { memoryUses } = uses(fetch, undefined, ledger());
    await memoryUses.report([], codexCounts({ t1: 4 }));
    await memoryUses.report([], codexCounts({ t1: 4 }));
    await memoryUses.report([], codexCounts({ t1: 6 }));
    expect(calls.map((call) => call.body.counts?.[0]?.count)).toEqual([4, 2]);
  });

  it("sends a rise again when the control plane did not take it, and holds the scans back", async () => {
    const { fetch, calls } = plane([503, 200, 200]);
    const { memoryUses } = uses(fetch, undefined, ledger());
    await memoryUses.report([CODEX_SCAN], codexCounts({ t1: 4 }));
    expect(calls).toHaveLength(1);
    await memoryUses.report([CODEX_SCAN], codexCounts({ t1: 5 }));
    expect(calls.map((call) => call.body.counts?.[0]?.count)).toEqual([
      4,
      5,
      undefined,
    ]);
  });

  it("drops a rise the control plane refuses, and does not send it again", async () => {
    const { fetch, calls } = plane([422, 200]);
    const { memoryUses, lines } = uses(fetch, undefined, ledger());
    await memoryUses.report([], codexCounts({ t1: 4 }));
    await memoryUses.report([], codexCounts({ t1: 4 }));
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([
      "memory uses: the control plane refused 1 harness counts (422); they are dropped",
    ]);
  });

  it("sends the rises in calls of at most 200", async () => {
    const { fetch, calls } = plane();
    const { memoryUses } = uses(fetch, undefined, ledger());
    const counts: Record<string, number> = {};
    for (let i = 0; i < MEMORY_COUNTS_PER_REPORT + 3; i += 1) counts[`t${i}`] = 1;
    await memoryUses.report([], codexCounts(counts));
    expect(calls.map((call) => call.body.counts?.length)).toEqual([
      MEMORY_COUNTS_PER_REPORT,
      3,
    ]);
  });

  it("sends no count without a ledger", async () => {
    const { fetch, calls } = plane();
    const { memoryUses } = uses(fetch);
    await memoryUses.report([], codexCounts({ t1: 4 }));
    expect(calls).toEqual([]);
  });
});

describe("a Stella citation", () => {
  const LINEAGE = "mem_3f9a1c0b7e2d4a5c6b8e9f01";

  it("is a use of its own beside a read of the same path in the same run", async () => {
    const { fetch, calls } = plane();
    const { memoryUses } = uses(fetch);
    memoryUses.note({ harness: "stella", path: LINEAGE, sessionUuid: RUN_A, at: at(NOW), signal: "citation" });
    memoryUses.note({ harness: "stella", path: LINEAGE, sessionUuid: RUN_A, at: at(NOW + 1_000), signal: "citation" });
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_A, at: at(NOW) });
    expect(memoryUses.size()).toBe(2);
    await memoryUses.report();
    // Reads go first, and a citation never shares a call with a read.
    expect(calls.map((call) => call.body.uses)).toEqual([
      [
        {
          harness: "claude-code",
          path: FILE,
          session_uuid: RUN_A,
          count: 1,
          used_at: at(NOW),
        },
      ],
      [
        {
          harness: "stella",
          path: LINEAGE,
          signal: "citation",
          session_uuid: RUN_A,
          count: 2,
          used_at: at(NOW + 1_000),
        },
      ],
    ]);
  });

  it("is dropped with its own call when the control plane refuses it, and the reads land", async () => {
    const { fetch, calls } = plane([200, 400]);
    const { memoryUses, lines } = uses(fetch);
    memoryUses.note({ harness: "stella", path: LINEAGE, sessionUuid: RUN_A, at: at(NOW), signal: "citation" });
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_A, at: at(NOW) });
    await memoryUses.report();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.uses?.[0]?.harness).toBe("claude-code");
    expect(memoryUses.size()).toBe(0);
    expect(lines).toEqual([
      "memory uses: the control plane refused 1 uses (400); they are dropped",
    ]);
  });

  it("waits with the reads when the control plane is down", async () => {
    const { fetch } = plane([503]);
    const { memoryUses } = uses(fetch);
    memoryUses.note({ harness: "stella", path: LINEAGE, sessionUuid: RUN_A, at: at(NOW), signal: "citation" });
    memoryUses.note({ harness: "claude-code", path: FILE, sessionUuid: RUN_A, at: at(NOW) });
    await memoryUses.report();
    expect(memoryUses.size()).toBe(2);
  });

  it("says when the queue had no room for it", () => {
    const { fetch } = plane();
    const { memoryUses } = uses(fetch);
    for (let i = 0; i < MEMORY_USES_QUEUED_MAX; i += 1)
      expect(
        memoryUses.note({ harness: "stella", path: `mem_${i}`, sessionUuid: RUN_A, at: at(NOW), signal: "citation" }),
      ).toBe(true);
    expect(
      memoryUses.note({ harness: "stella", path: "mem_more", sessionUuid: RUN_A, at: at(NOW), signal: "citation" }),
    ).toBe(false);
    // A use already queued still merges.
    expect(
      memoryUses.note({ harness: "stella", path: "mem_0", sessionUuid: RUN_A, at: at(NOW), signal: "citation" }),
    ).toBe(true);
    expect(memoryUses.size()).toBe(MEMORY_USES_QUEUED_MAX);
  });
});
