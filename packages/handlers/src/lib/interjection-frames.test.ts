// The rows a host's repository question writes (#3941): one per
// `control.interject`, keyed on the frame, and the host's own timeout
// closing it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { schema, type Tx } from "@oxagen/database";
import type { TachoEvent } from "@oxagen/tacho";
import { SKILL_INTERJECTION_TIMEOUT_MS } from "@oxagen/oxagen/skills";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logger", () => ({
  logger: { error: vi.fn(), warn, info: vi.fn() },
}));

const {
  HOST_TIMEOUT_ANSWER,
  interjectionRaisedEvents,
  isInterjectionFrame,
  recordInterjectionFrames,
  sendInterjectionsRaised,
} = await import("./interjection-frames");

const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const RUN = { publicId: "tse_0123456789abcdefghjkmn", agentKey: "acme.core.cc" };
const KEY = "01K6Z000000000000000000000";
const dialect = new PgDialect();

const QUESTION = {
  interjection_key: KEY,
  reason: "repo_unknown",
  question: "Link this repository to core, or create a workspace for it?",
  remote_digest: `sha256:${"e".repeat(64)}`,
  timeout_ms: 30 * 60 * 1000,
  expires_at: "2026-09-26T10:30:00.000Z",
  on_timeout: "deny",
  paths: [
    {
      path: "link",
      workspace_slug: "core",
      config_version: "skl_v2",
      skills_pinned: 3,
      linked_repositories: 1,
    },
    {
      path: "create",
      proposed_name: "payments",
      proposed_slug: "payments",
      skills_enabled: false,
    },
  ],
};

function frame(
  seq: number,
  kind: string,
  body: Record<string, unknown>,
  ts = "2026-09-26T10:00:00.000Z",
): TachoEvent {
  return { seq, kind, body, ts } as unknown as TachoEvent;
}

/**
 * A transaction that records each insert and update. An insert answers the
 * rows `returned` holds, as `ON CONFLICT DO NOTHING ... RETURNING` answers
 * only the rows it wrote.
 */
function fakeTx(returned: unknown[][] = []) {
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> =
    [];
  const conflicts: string[] = [];
  const updates: Array<{
    table: unknown;
    values: Record<string, unknown>;
    where: SQL;
  }> = [];
  const tx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return {
          onConflictDoNothing: (target?: unknown) => {
            conflicts.push(target === undefined ? "any" : "target");
            return { returning: async () => returned.shift() ?? [] };
          },
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async (where: SQL) => {
          updates.push({ table, values, where });
          return [];
        },
      }),
    }),
  };
  return { tx: tx as unknown as Tx, inserts, conflicts, updates };
}

beforeEach(() => warn.mockClear());

describe("recordInterjectionFrames", () => {
  it("writes one repo_unknown row per question, keyed on its frame, with the control plane's own deadline", async () => {
    const expiresAt = new Date("2026-09-26T10:30:00.000Z");
    const { tx, inserts, conflicts } = fakeTx([
      [{ publicId: "inj_abc", expiresAt }],
    ]);
    const raised = await recordInterjectionFrames(tx, SCOPE, RUN, [
      frame(1, "repo.unknown", {}),
      frame(2, "control.interject", QUESTION),
    ]);
    expect(raised).toEqual([{ interjectionId: "inj_abc", expiresAt }]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe(schema.interjections);
    const raisedAt = new Date("2026-09-26T10:00:00.000Z");
    expect(inserts[0]?.values).toEqual({
      orgId: SCOPE.orgId,
      workspaceId: SCOPE.workspaceId,
      runPublicId: RUN.publicId,
      agentKey: RUN.agentKey,
      question: QUESTION.question,
      raisedAt,
      expiresAt: new Date(raisedAt.getTime() + SKILL_INTERJECTION_TIMEOUT_MS),
      kind: "repo_unknown",
      raisedSeq: 2,
      body: QUESTION,
    });
    // Any conflict, the frame's key among them, writes nothing.
    expect(conflicts).toEqual(["any"]);
  });

  it("answers no row for a frame already recorded, so nothing is announced twice", async () => {
    const { tx, inserts } = fakeTx([[]]);
    const raised = await recordInterjectionFrames(tx, SCOPE, RUN, [
      frame(2, "control.interject", QUESTION),
    ]);
    expect(inserts).toHaveLength(1);
    expect(raised).toEqual([]);
  });

  it("writes no row for a body that fails its schema, and logs it (negative)", async () => {
    const { tx, inserts } = fakeTx();
    const raised = await recordInterjectionFrames(tx, SCOPE, RUN, [
      frame(2, "control.interject", { ...QUESTION, reason: "curious" }),
      frame(3, "control.interject", { question: "free text" }),
    ]);
    expect(raised).toEqual([]);
    expect(inserts).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("closes the row when the host answered deny on its own timeout", async () => {
    const { tx, updates } = fakeTx();
    await recordInterjectionFrames(tx, SCOPE, RUN, [
      frame(
        9,
        "control.answer",
        { interjection_key: KEY, path: "deny", source: "timeout" },
        "2026-09-26T10:30:01.000Z",
      ),
    ]);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.table).toBe(schema.interjections);
    expect(updates[0]?.values).toMatchObject({
      answeredAt: new Date("2026-09-26T10:30:01.000Z"),
      answer: HOST_TIMEOUT_ANSWER,
      path: "deny",
      answeredByUserId: null,
    });
    const where = dialect.sqlToQuery(updates[0]?.where as SQL);
    // Only an open row of this run, found by the key the host minted.
    expect(where.sql).toContain('"answered_at" is null');
    expect(where.sql).toContain("->> 'interjection_key'");
    expect(where.params).toContain(KEY);
    expect(where.params).toContain(RUN.publicId);
  });

  it("leaves a person's answer to answer_interjection, which recorded it first", async () => {
    const { tx, updates, inserts } = fakeTx();
    await recordInterjectionFrames(tx, SCOPE, RUN, [
      frame(9, "control.answer", {
        interjection_key: KEY,
        path: "link",
        source: "person",
        receipt_id: "rcp_01a2",
      }),
    ]);
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it("reads only the two question kinds", () => {
    expect(isInterjectionFrame({ kind: "control.interject" })).toBe(true);
    expect(isInterjectionFrame({ kind: "control.answer" })).toBe(true);
    expect(isInterjectionFrame({ kind: "repo.unknown" })).toBe(false);
    expect(isInterjectionFrame({ kind: "oxagen:command_applied" })).toBe(false);
  });
});

describe("the raised events", () => {
  const raised = [
    {
      interjectionId: "inj_abc",
      expiresAt: new Date("2026-09-26T10:30:00.000Z"),
    },
  ];

  it("names each by its row, so a retried send starts one timeout", () => {
    expect(interjectionRaisedEvents(SCOPE, raised)).toEqual([
      {
        name: "agent/interjection.raised",
        id: "interjection-raised:inj_abc",
        data: {
          orgId: SCOPE.orgId,
          workspaceId: SCOPE.workspaceId,
          interjectionId: "inj_abc",
          expiresAt: "2026-09-26T10:30:00.000Z",
        },
      },
    ]);
  });

  it("sends nothing for no rows", async () => {
    const send = vi.fn();
    await sendInterjectionsRaised(send, SCOPE, []);
    expect(send).not.toHaveBeenCalled();
  });

  it("logs a failed send and never fails the ingest (negative)", async () => {
    const send = vi.fn(async () => {
      throw new Error("event bus down");
    });
    await expect(
      sendInterjectionsRaised(send, SCOPE, raised),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
