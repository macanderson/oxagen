// findings-run-facts.test.ts — the per-run reads the findings pass adds
// (ADR-210), over a stubbed Postgres transaction and a stubbed ClickHouse
// select.
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A transaction stub: each awaited statement returns the next rows queued. */
const { pgResults, tx } = vi.hoisted(() => {
  const pgResults: unknown[][] = [];
  const tx: Record<string, unknown> = {};
  tx.select = () => tx;
  tx.from = () => tx;
  tx.innerJoin = () => tx;
  tx.where = () => {
    const rows = Promise.resolve(pgResults.shift() ?? []);
    return Object.assign(rows, { groupBy: () => rows });
  };
  return { pgResults, tx };
});

vi.mock("@oxagen/database", () => ({
  schema: { tachoSessions: {}, tachoSessionFiles: {}, agentRuns: {} },
  withSystemDb: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  ne: vi.fn(),
  sql: vi.fn(),
}));
vi.mock("@oxagen/telemetry", () => ({ chSelect: vi.fn() }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
}));
vi.mock("./run-pr-outcomes-store", () => ({ readOutcomeRows: vi.fn() }));

import { withSystemDb } from "@oxagen/database";
import { chSelect } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import type { RunTotalsRecord } from "./cost-rollup";
import {
  readCompactions,
  readFileChanges,
  readFirstPrompts,
  readOutcomes,
  readRunRefs,
  RUN_FACTS_CHUNK,
} from "./findings-run-facts";
import { microsOf } from "./findings/shared";
import type { OutcomeRow } from "./run-pr-outcomes";
import { readOutcomeRows } from "./run-pr-outcomes-store";

const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const ROOT = "00000000-0000-4000-8000-0000000000aa";
const CHILD = "00000000-0000-4000-8000-0000000000cc";
const RUN = "tse_0000000000000000000001";
const FROM = new Date("2026-08-28T00:00:00.000Z");
const micros = microsOf;

function run(runId: string, runSource: "tacho" | "ledger"): RunTotalsRecord {
  return { runId, runSource } as RunTotalsRecord;
}

beforeEach(() => {
  pgResults.length = 0;
  vi.mocked(chSelect).mockReset();
  vi.mocked(readOutcomeRows).mockReset();
  vi.mocked(withSystemDb).mockClear();
});

describe("readRunRefs", () => {
  it("names a wrapped run's root and its subagent sessions, and a ledger run's row", async () => {
    pgResults.push(
      [
        { sessionUuid: "00000000-0000-4000-8000-0000000000dd", rootSessionUuid: ROOT },
        { sessionUuid: CHILD, rootSessionUuid: ROOT },
      ],
      [
        {
          publicId: "arun_x",
          runUuid: "00000000-0000-4000-8000-0000000000ee",
          originMessageId: null,
        },
      ],
    );
    const out = await readRunRefs(
      SCOPE,
      [run(RUN, "tacho"), run("arun_x", "ledger"), run("arun_gone", "ledger")],
      new Map([[ROOT, RUN]]),
    );
    expect(out.get(RUN)).toEqual({
      kind: "tacho",
      rootSessionUuid: ROOT,
      sessionUuids: [ROOT, CHILD, "00000000-0000-4000-8000-0000000000dd"],
    });
    expect(out.get("arun_x")).toEqual({
      kind: "ledger",
      runUuid: "00000000-0000-4000-8000-0000000000ee",
      originMessageId: null,
    });
    // A ledger run with no v2 row has no source.
    expect(out.has("arun_gone")).toBe(false);
  });

  it("names a wrapped run with no subagent by its root alone, and skips a run with no root session", async () => {
    const out = await readRunRefs(
      SCOPE,
      [run(RUN, "tacho"), run("tse_orphan", "tacho")],
      new Map([[ROOT, RUN]]),
    );
    expect([...out]).toEqual([
      [RUN, { kind: "tacho", rootSessionUuid: ROOT, sessionUuids: [ROOT] }],
    ]);
  });
});

describe("readFirstPrompts", () => {
  it("reads each root's first prompt in the tenant scope and maps it to the run", async () => {
    vi.mocked(chSelect).mockResolvedValueOnce({
      data: [
        {
          root: ROOT,
          at: "2026-09-10T10:00:00.123456Z",
          prompt_digest: "sha256:p",
          prompt_source: "typed",
          prompt_origin: "",
          command_name: "",
        },
        {
          root: "00000000-0000-4000-8000-0000000000ff",
          at: "2026-09-10T10:00:00.000000Z",
          prompt_digest: "sha256:q",
          prompt_source: null,
          prompt_origin: null,
          command_name: null,
        },
      ],
    } as never);
    const out = await readFirstPrompts(SCOPE, new Map([[RUN, ROOT]]), FROM);
    expect(runInTenantScope).toHaveBeenCalledWith(SCOPE, expect.any(Function));
    const call = vi.mocked(chSelect).mock.calls[0]?.[0] as {
      query: string;
      params: Record<string, unknown>;
    };
    expect(call.query).toContain("kind = 'turn_start'");
    expect(call.query).toContain("LIMIT 1 BY root_session_uuid");
    // No alias names a column, so the filters read the stored uuids.
    expect(call.query).not.toMatch(/AS (root_session_uuid|session_uuid)\b/);
    expect(call.params).toEqual({
      roots: [ROOT],
      from: "2026-08-28 00:00:00.000",
    });
    expect([...out]).toEqual([
      [
        RUN,
        {
          at: new Date("2026-09-10T10:00:00.123Z"),
          atMicros: micros("2026-09-10T10:00:00.123456Z"),
          digest: "sha256:p",
          source: "typed",
          origin: null,
          commandName: null,
        },
      ],
    ]);
  });

  it("reads nothing for no run", async () => {
    expect((await readFirstPrompts(SCOPE, new Map(), FROM)).size).toBe(0);
    expect(chSelect).not.toHaveBeenCalled();
  });
});

describe("readCompactions", () => {
  it("counts a hook's PostCompact frame alone, and lists each run's compactions in order", async () => {
    vi.mocked(chSelect).mockResolvedValueOnce({
      data: [
        {
          root: ROOT,
          chain: CHILD,
          seq: "4",
          at: "2026-09-10T11:00:00.000000Z",
          compact_trigger: "auto",
          tokens_before: "180000",
          tokens_after: null,
        },
        {
          root: ROOT,
          chain: ROOT,
          seq: 9,
          at: "2026-09-10T10:00:00.000000Z",
          compact_trigger: "",
          tokens_before: 150_000,
          tokens_after: 30_000,
        },
      ],
    } as never);
    const out = await readCompactions(SCOPE, new Map([[RUN, ROOT]]), FROM);
    const call = vi.mocked(chSelect).mock.calls[0]?.[0] as { query: string };
    expect(call.query).toContain(
      "(hook_event_name = 'PostCompact' OR source != 'hook')",
    );
    expect(out.get(RUN)).toEqual([
      {
        at: new Date("2026-09-10T10:00:00.000Z"),
        atMicros: micros("2026-09-10T10:00:00.000000Z"),
        seq: 9,
        sessionUuid: null,
        trigger: null,
        tokensBefore: 150_000,
        tokensAfter: 30_000,
      },
      {
        at: new Date("2026-09-10T11:00:00.000Z"),
        atMicros: micros("2026-09-10T11:00:00.000000Z"),
        seq: 4,
        sessionUuid: CHILD,
        trigger: "auto",
        tokensBefore: 180_000,
        tokensAfter: null,
      },
    ]);
  });
});

describe("readFileChanges", () => {
  it("answers every wrapped run, true only where a session changed a file", async () => {
    const OTHER_ROOT = "00000000-0000-4000-8000-0000000000bb";
    pgResults.push([
      { root: ROOT, changed: true },
      { root: OTHER_ROOT, changed: false },
    ]);
    const out = await readFileChanges(
      SCOPE,
      new Map([
        [RUN, ROOT],
        ["tse_other", OTHER_ROOT],
        ["tse_none", "00000000-0000-4000-8000-0000000000ee"],
      ]),
    );
    expect([...out]).toEqual([
      [RUN, true],
      ["tse_other", false],
      ["tse_none", false],
    ]);
  });

  it("reads nothing for no run", async () => {
    expect((await readFileChanges(SCOPE, new Map())).size).toBe(0);
    expect(withSystemDb).not.toHaveBeenCalled();
  });
});

describe("readOutcomes", () => {
  it("groups each run's outcome rows, in chunks of the statement cap", async () => {
    const row = (runId: string, prNumber: number) =>
      ({ runId, prNumber }) as unknown as OutcomeRow;
    vi.mocked(readOutcomeRows)
      .mockResolvedValueOnce([row(RUN, 1), row(RUN, 2)])
      .mockResolvedValueOnce([row("tse_last", 3)]);
    const ids = Array.from({ length: RUN_FACTS_CHUNK + 1 }, (_, i) =>
      i === 0 ? RUN : i === RUN_FACTS_CHUNK ? "tse_last" : `tse_${i}`,
    );
    const out = await readOutcomes(SCOPE, ids);
    expect(readOutcomeRows).toHaveBeenCalledTimes(2);
    expect(vi.mocked(readOutcomeRows).mock.calls[1]?.[1]).toEqual(["tse_last"]);
    expect(out.get(RUN)).toEqual([row(RUN, 1), row(RUN, 2)]);
    expect(out.get("tse_last")).toEqual([row("tse_last", 3)]);
    expect(out.size).toBe(2);
  });
});
