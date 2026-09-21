/**
 * Unit tests for the list_skills handler: the window it reads, the cursor
 * that carries it, the counts it returns and the refusals it makes before any
 * read. The role gate is a module double here; the gate against real role
 * rows, tenant isolation and the SQL semantics (a null inventory versus an
 * empty one, the window's bounds) run against Postgres in skill.list.pg.test.ts.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { skillList } from "@oxagen/oxagen/contracts/skill.list";
import { makeCTX } from "./test-utils/fixtures";

const gate = vi.hoisted(() => ({
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => gate);

import {
  createSkillListHandler,
  decodeSkillCursor,
  encodeSkillCursor,
  namesQuery,
  type SkillQueries,
  toInventoryRow,
  windowEndingAt,
} from "./skill.list";

const NOW = new Date("2026-09-15T12:00:00.000Z");
const ctx = makeCTX({
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-00000000ac40",
  userId: "0192d4a8-7c1e-7a00-8000-0000000005e1",
});

const skillRow = (name: string) => ({
  name,
  sessions: 1,
  harnesses: ["claude-code"],
  harnessCount: 1,
  firstSeenAt: "2026-09-14T09:00:00.000Z",
  lastSeenAt: "2026-09-14T09:00:00.000Z",
});

function handlerWith(over: Partial<SkillQueries> = {}) {
  const queries: SkillQueries = {
    read: vi.fn(async () => ({
      totals: { sessions: 3, reported: 2 },
      rows: [skillRow("release-notes")],
    })),
    ...over,
  };
  const handler = createSkillListHandler({ queries, now: () => NOW });
  const list = (input: unknown) => handler(skillList.input.parse(input), ctx);
  return { queries, list };
}

beforeEach(() => {
  gate.assertOrgRole.mockReset();
  gate.assertOrgRole.mockResolvedValue("Member");
  gate.resolveActingUserId.mockReset();
  gate.resolveActingUserId.mockResolvedValue(ctx.userId);
});

describe("list_skills handler", () => {
  it("gates the acting user on the workspace's members before any read", async () => {
    const { list } = handlerWith();
    await list({});
    expect(gate.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ctx.orgId, userId: ctx.userId }),
      { org: ["Owner", "Admin", "Member"], workspace: ["Owner", "Member"] },
    );
  });

  it("reads nothing for a refused actor (negative)", async () => {
    gate.assertOrgRole.mockRejectedValue(
      new HandlerError({ code: "forbidden", reason: "org_role_required" }),
    );
    const { queries, list } = handlerWith();
    await expect(list({})).rejects.toMatchObject({ code: "forbidden" });
    expect(queries.read).not.toHaveBeenCalled();
  });

  it("reads the last 30 days up to now in this workspace by default, and the asked window otherwise", async () => {
    const { queries, list } = handlerWith();
    const out = await list({});
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const window = {
      from: new Date("2026-08-16T12:00:00.000Z"),
      to: NOW,
    };
    expect(queries.read).toHaveBeenCalledWith(scope, window, {
      after: null,
      limit: 100,
    });
    expect(out.window).toEqual({
      from: "2026-08-16T12:00:00.000Z",
      to: "2026-09-15T12:00:00.000Z",
    });

    await list({ windowDays: 7 });
    expect(queries.read).toHaveBeenLastCalledWith(
      scope,
      {
        from: new Date("2026-09-08T12:00:00.000Z"),
        to: NOW,
      },
      { after: null, limit: 100 },
    );
  });

  it("returns the window's counts, with sessions that reported nothing counted as not reported", async () => {
    const { list } = handlerWith();
    const out = await list({});
    expect(out).toMatchObject({
      sessions: 3,
      reportedSessions: 2,
      notReportedSessions: 1,
      skills: [skillRow("release-notes")],
      nextCursor: null,
    });
    expect(skillList.output.parse(out)).toEqual(out);
  });

  it("returns a null reported count, never a zero, when no session in the window reported an inventory", async () => {
    const { list } = handlerWith({
      read: vi.fn(async () => ({
        totals: { sessions: 2, reported: 0 },
        rows: [],
      })),
    });
    const out = await list({});
    expect(out.reportedSessions).toBeNull();
    expect(out.notReportedSessions).toBe(2);
    expect(out.skills).toEqual([]);
  });

  it("pages past a full page with a cursor that keeps the first page's window", async () => {
    const full = Array.from({ length: 101 }, (_, i) =>
      skillRow(`skill-${String(i).padStart(3, "0")}`),
    );
    const read = vi
      .fn<SkillQueries["read"]>()
      .mockResolvedValueOnce({
        totals: { sessions: 101, reported: 101 },
        rows: full,
      })
      .mockResolvedValueOnce({
        totals: { sessions: 101, reported: 101 },
        rows: [skillRow("skill-100")],
      });
    const { queries, list } = handlerWith({ read });
    const first = await list({});
    expect(first.skills).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();

    const later = new Date("2026-09-20T00:00:00.000Z");
    const handler = createSkillListHandler({ queries, now: () => later });
    const second = await handler(
      skillList.input.parse({ cursor: first.nextCursor, windowDays: 7 }),
      ctx,
    );
    expect(read).toHaveBeenLastCalledWith(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      { from: new Date("2026-08-16T12:00:00.000Z"), to: NOW },
      { after: "skill-099", limit: 100 },
    );
    expect(second.window).toEqual(first.window);
    expect(second.nextCursor).toBeNull();
  });

  it("refuses a cursor it did not write as invalid_input before any read (negative)", async () => {
    const { queries, list } = handlerWith();
    for (const cursor of [
      "not-a-cursor",
      Buffer.from(JSON.stringify(["x", "y", "z"])).toString("base64url"),
      Buffer.from(
        JSON.stringify([NOW.toISOString(), NOW.toISOString(), "a"]),
      ).toString("base64url"),
    ])
      await expect(list({ cursor })).rejects.toMatchObject({
        code: "invalid_input",
      });
    expect(queries.read).not.toHaveBeenCalled();
  });
});

describe("the cursor", () => {
  it("round-trips its window and last name", () => {
    const cursor = { window: windowEndingAt(NOW, 30), after: "release-notes" };
    expect(decodeSkillCursor(encodeSkillCursor(cursor))).toEqual(cursor);
  });

  it("refuses an empty last name (negative)", () => {
    const raw = encodeSkillCursor({
      window: windowEndingAt(NOW, 1),
      after: "",
    });
    expect(decodeSkillCursor(raw)).toBeNull();
  });

  it("refuses a hand-made window longer than windowDays allows (negative)", () => {
    const encoded = (days: number) =>
      Buffer.from(
        JSON.stringify([
          new Date(NOW.getTime() - days * 86_400_000).toISOString(),
          NOW.toISOString(),
          "release-notes",
        ]),
        "utf8",
      ).toString("base64url");
    expect(decodeSkillCursor(encoded(91))).toBeNull();
    expect(decodeSkillCursor(encoded(3650))).toBeNull();
    expect(decodeSkillCursor(encoded(90))).not.toBeNull();
  });
});

describe("toInventoryRow", () => {
  it("carries the jsonb harness array and harness count through, and keeps the reported instants", () => {
    expect(
      toInventoryRow({
        name: "release-notes",
        sessions: "2",
        harnesses: ["claude-code", "codex"],
        harness_count: "2",
        first_seen_at: "2026-09-01T09:00:00.000Z",
        last_seen_at: "2026-09-14T09:00:00.000Z",
      }),
    ).toEqual({
      name: "release-notes",
      sessions: 2,
      harnesses: ["claude-code", "codex"],
      harnessCount: 2,
      firstSeenAt: "2026-09-01T09:00:00.000Z",
      lastSeenAt: "2026-09-14T09:00:00.000Z",
    });
  });

  it("round-trips a harness label containing a newline whole, never re-split into invented labels", () => {
    expect(
      toInventoryRow({
        name: "release-notes",
        sessions: "1",
        harnesses: ["claude-code\ncodex"],
        harness_count: "1",
        first_seen_at: "2026-09-01T09:00:00.000Z",
        last_seen_at: "2026-09-01T09:00:00.000Z",
      }).harnesses,
    ).toEqual(["claude-code\ncodex"]);
  });

  it("keeps a session with an empty harness label rather than failing the whole read", () => {
    expect(
      toInventoryRow({
        name: "release-notes",
        sessions: "1",
        harnesses: ["", "claude-code"],
        harness_count: "2",
        first_seen_at: "2026-09-01T09:00:00.000Z",
        last_seen_at: "2026-09-01T09:00:00.000Z",
      }).harnesses,
    ).toEqual(["", "claude-code"]);
  });

  it("fails a row with no session, no harness, or a non-positive harness count rather than guessing (negative)", () => {
    const base = {
      name: "x",
      sessions: 1,
      harnesses: ["claude-code"],
      harness_count: 1,
      first_seen_at: "2026-09-01T09:00:00.000Z",
      last_seen_at: "2026-09-01T09:00:00.000Z",
    };
    expect(() => toInventoryRow({ ...base, sessions: 0 })).toThrow();
    expect(() => toInventoryRow({ ...base, harnesses: [] })).toThrow();
    expect(() => toInventoryRow({ ...base, harness_count: 0 })).toThrow();
  });
});

describe("namesQuery", () => {
  const dialect = new PgDialect();
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const window = windowEndingAt(NOW, 30);

  it("filters by the page cursor in the first scan, before harnesses are ranked or aggregated", () => {
    const { sql: text, params } = dialect.sqlToQuery(
      namesQuery(scope, window, { after: "release-notes", limit: 100 }),
    );
    const cursorAt = text.indexOf("skill.name > $");
    expect(cursorAt).toBeGreaterThan(-1);
    expect(cursorAt).toBeLessThan(text.indexOf("ranked_harness as ("));
    expect(params).toContain("release-notes");
  });

  it("adds no cursor predicate on the first page", () => {
    const { sql: text } = dialect.sqlToQuery(
      namesQuery(scope, window, { after: null, limit: 100 }),
    );
    expect(text).not.toContain("skill.name > $");
  });
});
