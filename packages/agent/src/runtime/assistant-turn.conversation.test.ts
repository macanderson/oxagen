/**
 * The conversation a turn writes to (#4163). A turn continues only a
 * conversation the person asking may continue: in this org and workspace,
 * theirs, not deleted and not archived. Until #4163 the lookup matched on the
 * tenant alone. The reply also stores what the turn parked, so a thread read
 * back after a reload shows the same notice.
 */
import { describe, expect, it } from "vitest";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { schema } from "@oxagen/database";
import {
  appendAssistantMessage,
  appendUserMessage,
  ConversationNotFoundError,
  conversationTitleFrom,
} from "./assistant-turn";

const dialect = new PgDialect();
const CONVERSATIONS = getTableName(schema.conversations);
const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-0000000000f1",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000f2",
};
const USER = "0192d4a8-7c1e-7a00-8000-0000000000f3";
const CONVERSATION = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000c1",
  publicId: "cnv_01k9x2tq",
};

interface Captured {
  lookups: { where: string; params: unknown[] }[];
  inserts: { table: string; values: Record<string, unknown> }[];
  updates: { table: string; set: Record<string, unknown> }[];
}

/**
 * A transaction whose conversation lookup answers `found`. The lookup is the
 * read that projects `publicId`. The history read (#4195) also selects from
 * conversations, for the stored summary, and answers no summary here.
 */
function fakeTx(found: (typeof CONVERSATION)[]) {
  const captured: Captured = { lookups: [], inserts: [], updates: [] };
  const tx = {
    select: (projection?: Record<string, unknown>) => ({
      from: (table: Parameters<typeof getTableName>[0]) => ({
        where: (cond: SQL) => {
          const isLookup =
            getTableName(table) === CONVERSATIONS &&
            projection !== undefined &&
            "publicId" in projection;
          if (isLookup) {
            const q = dialect.sqlToQuery(cond);
            captured.lookups.push({ where: q.sql, params: q.params });
          }
          const chain = {
            orderBy: () => chain,
            offset: () => chain,
            limit: () => Promise.resolve(isLookup ? found : []),
          };
          return chain;
        },
      }),
    }),
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (values: Record<string, unknown>) => {
        const name = getTableName(table);
        captured.inserts.push({ table: name, values });
        return {
          returning: () =>
            Promise.resolve([
              name === CONVERSATIONS
                ? { id: "new-conversation", publicId: "cnv_new" }
                : { id: `msg-${String(values.role)}` },
            ]),
        };
      },
    }),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (set: Record<string, unknown>) => {
        captured.updates.push({ table: getTableName(table), set });
        return { where: () => Promise.resolve() };
      },
    }),
  };
  return {
    captured,
    tx: tx as unknown as Parameters<typeof appendUserMessage>[0],
  };
}

const ask = (conversationId: string | null) => ({
  conversationId,
  content: "what is live?",
  pageContext: null,
});

describe("appendUserMessage", () => {
  it("continues only the asker's own conversation, and never a deleted or archived one", async () => {
    const { tx, captured } = fakeTx([CONVERSATION]);
    await appendUserMessage(tx, SCOPE, USER, ask(CONVERSATION.id), "chat");
    const [lookup] = captured.lookups;
    expect(lookup?.where).toMatch(/"id" = \$/);
    expect(lookup?.where).toMatch(/"org_id" = \$/);
    expect(lookup?.where).toMatch(/"workspace_id" = \$/);
    expect(lookup?.where).toMatch(/"user_id" = \$/);
    expect(lookup?.where).toMatch(/"deleted_at" is null/);
    expect(lookup?.where).toMatch(/"archived_at" is null/);
    expect(lookup?.params).toEqual(
      expect.arrayContaining([
        CONVERSATION.id,
        SCOPE.orgId,
        SCOPE.workspaceId,
        USER,
      ]),
    );
  });

  it("refuses a conversation that is another member's, deleted, archived or missing, before anything is written (negative)", async () => {
    // Every one of those cases is a lookup that answers no row: the filter
    // above is what makes another member's, a deleted and an archived
    // conversation read as missing.
    const { tx, captured } = fakeTx([]);
    const named = ask(CONVERSATION.publicId);
    const refused = appendUserMessage(tx, SCOPE, USER, named, "chat");
    await expect(refused).rejects.toBeInstanceOf(ConversationNotFoundError);
    await expect(refused).rejects.toMatchObject({ code: "not_found" });
    expect(captured.inserts).toHaveLength(0);
  });

  it("continues a conversation named by its cnv_ public id and answers both ids", async () => {
    const { tx, captured } = fakeTx([CONVERSATION]);
    const out = await appendUserMessage(
      tx,
      SCOPE,
      USER,
      ask(CONVERSATION.publicId),
      "chat",
    );
    expect(captured.lookups[0]?.where).toMatch(/"public_id" = \$/);
    expect(captured.lookups[0]?.params).toContain(CONVERSATION.publicId);
    expect(out).toMatchObject({
      conversationId: CONVERSATION.id,
      conversationPublicId: CONVERSATION.publicId,
      userMessageId: "msg-user",
    });
    expect(captured.inserts.map((i) => i.values.conversationId)).toEqual([
      CONVERSATION.id,
    ]);
  });

  it("opens a conversation owned by the asker when none is named", async () => {
    const { tx, captured } = fakeTx([]);
    const out = await appendUserMessage(tx, SCOPE, USER, ask(null), "chat");
    // No ownership lookup: nothing was named. The history read of the new
    // conversation's summary row (#4195) selects by id alone.
    expect(
      captured.lookups.filter((l) => l.where.includes('"user_id"')),
    ).toHaveLength(0);
    expect(captured.inserts[0]).toMatchObject({
      table: CONVERSATIONS,
      values: {
        userId: USER,
        title: "what is live?",
        status: "active",
        ...SCOPE,
      },
    });
    expect(out).toMatchObject({
      conversationId: "new-conversation",
      conversationPublicId: "cnv_new",
    });
  });

  it("names a new conversation after its first question, with whitespace collapsed", async () => {
    const { tx, captured } = fakeTx([]);
    const question = {
      ...ask(null),
      content: "  why did\n\nthe deploy\t fail?  ",
    };
    await appendUserMessage(tx, SCOPE, USER, question, "chat");
    expect(captured.inserts[0]?.values.title).toBe("why did the deploy fail?");
  });

  it("marks a continued conversation active when the question is written, before any reply", async () => {
    // The nightly archive (#4435) reads updated_at. A question whose turn is
    // still running, or failed, must not leave the conversation looking idle.
    const { tx, captured } = fakeTx([CONVERSATION]);
    await appendUserMessage(tx, SCOPE, USER, ask(CONVERSATION.id), "chat");
    const bumps = captured.updates.filter(
      (u) => u.table === CONVERSATIONS && "updatedAt" in u.set,
    );
    expect(bumps).toHaveLength(1);
    expect(bumps[0]?.set.updatedAt).toBeInstanceOf(Date);
  });

  it("writes no activity bump for a new conversation, whose insert sets it", async () => {
    const { tx, captured } = fakeTx([]);
    await appendUserMessage(tx, SCOPE, USER, ask(null), "chat");
    expect(
      captured.updates.filter((u) => u.table === CONVERSATIONS),
    ).toHaveLength(0);
  });

  it("leaves the title of a continued conversation alone", async () => {
    const { tx, captured } = fakeTx([CONVERSATION]);
    await appendUserMessage(tx, SCOPE, USER, ask(CONVERSATION.id), "chat");
    expect(captured.inserts.map((i) => i.table)).not.toContain(CONVERSATIONS);
    expect(captured.updates.filter((u) => "title" in u.set)).toHaveLength(0);
  });
});

describe("conversationTitleFrom", () => {
  it("keeps a question of 80 code points whole", () => {
    const question = "a".repeat(80);
    expect(conversationTitleFrom(question)).toBe(question);
  });

  it("cuts a longer question to 80 code points and ends it in an ellipsis", () => {
    const title = conversationTitleFrom("b".repeat(100));
    expect(title).toBe(`${"b".repeat(80)}…`);
    expect(Array.from(title ?? "")).toHaveLength(81);
  });

  it("cuts on a code point, so an emoji at the edge stays whole", () => {
    // Each emoji is two UTF-16 units, so a cut by string length keeps 40.
    const title = conversationTitleFrom("😀".repeat(90));
    expect(title).toBe(`${"😀".repeat(80)}…`);
  });

  it("drops the space the cut leaves before the ellipsis", () => {
    const title = conversationTitleFrom(`${"c".repeat(79)} ${"d".repeat(30)}`);
    expect(title).toBe(`${"c".repeat(79)}…`);
  });

  it("answers null for a question that is only whitespace", () => {
    expect(conversationTitleFrom(" \n\t ")).toBeNull();
    expect(conversationTitleFrom("")).toBeNull();
  });
});

describe("appendAssistantMessage", () => {
  const CARD = {
    approvalId: "apr_01k5rt9xq7v3m8n2p4s6t8w0",
    capability: "set_budget",
    expiresAt: "2026-09-25T10:05:00.000Z",
  };

  it("stores the writes the turn parked on the reply, so a reload shows them", async () => {
    const { tx, captured } = fakeTx([]);
    const id = await appendAssistantMessage(
      tx,
      SCOPE,
      USER,
      CONVERSATION.id,
      "That write waits on a person.",
      { surface: "chat", runId: "arun_0002", parkedCards: [CARD] },
    );
    expect(id).toBe("msg-assistant");
    expect(captured.inserts[0]?.values.metadata).toEqual({
      status: "complete",
      surface: "chat",
      runId: "arun_0002",
      parkedCards: [CARD],
    });
    expect(captured.updates[0]?.set).toMatchObject({
      activeLeafMessageId: "msg-assistant",
    });
  });

  it("stores no parked cards on a reply that parked nothing", async () => {
    const { tx, captured } = fakeTx([]);
    await appendAssistantMessage(tx, SCOPE, USER, CONVERSATION.id, "hi", {
      surface: "chat",
      runId: "arun_0001",
      parkedCards: [],
    });
    expect(captured.inserts[0]?.values.metadata).toEqual({
      status: "complete",
      surface: "chat",
      runId: "arun_0001",
    });
  });
});
