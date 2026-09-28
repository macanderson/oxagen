/**
 * Conversation title backfill (#4571)
 *
 * Replays 20260928061500_conversation_title_source.sql against conversations
 * written before the column existed, and proves the backfill: an untitled
 * conversation, or one whose title the old code cut from its first question,
 * is named again from that first question in at most 72 characters and marked
 * 'prompt'. A title a person set is kept and marked 'user'. The whole replay
 * runs in one transaction that rolls back, so the migrated schema is left as
 * it was.
 *
 * CI: rls-integration job (clean, migrated DB).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });
afterAll(() => sql.end());

const LONG =
  "Fix the login redirect so a person who signs in from a shared link lands on the page they asked for";

it("names old conversations from their first question and keeps renames", async () => {
  const migration = readFileSync(
    new URL(
      "../atlas/migrations/20260928061500_conversation_title_source.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const org = randomUUID();
  const workspace = randomUUID();
  const user = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const rollback = new Error("Roll back title backfill fixture");

  await expect(
    sql.begin(async (tx) => {
      await tx.unsafe(`
        ALTER TABLE chat.conversations DROP CONSTRAINT conversations_title_source_check;
        ALTER TABLE chat.conversations DROP COLUMN title_source;
      `);

      const ids = new Map<string, string>();
      const conversation = async (key: string, title: string | null) => {
        const id = randomUUID();
        ids.set(key, id);
        await tx`
          INSERT INTO chat.conversations
            (id, public_id, org_id, workspace_id, user_id, status, title)
          VALUES
            (${id}, ${`t4571_${tag}_${key}`}, ${org}, ${workspace}, ${user}, 'active', ${title})
        `;
      };
      let minute = 0;
      const message = async (key: string, role: string, content: string) => {
        minute += 1;
        await tx`
          INSERT INTO chat.messages
            (id, public_id, org_id, workspace_id, conversation_id, role, content, content_blocks, created_at)
          VALUES
            (${randomUUID()}, ${`t4571_${tag}_m${minute}`}, ${org}, ${workspace}, ${ids.get(key)!},
             ${role}, ${content}, '[]'::jsonb, ${`2026-09-01T00:${String(minute).padStart(2, "0")}:00Z`})
        `;
      };

      // Untitled: whitespace collapses.
      await conversation("untitled", null);
      await message("untitled", "user", "  Fix   the login\nredirect  ");
      // The old code's cut: 80 characters and an ellipsis.
      await conversation("old_cut", `${LONG.slice(0, 80).trimEnd()}…`);
      await message("old_cut", "user", LONG);
      // The old code's whole question, 77 characters.
      const question =
        "Rename the spend waste column so a reader sees the session name for every run";
      await conversation("old_whole", question);
      await message("old_whole", "user", question);
      // A rename.
      await conversation("renamed", "Release checklist");
      await message("renamed", "user", "Ship the release");
      // No question to name it from.
      await conversation("no_question", null);
      await message("no_question", "assistant", "Hello");
      await conversation("blank", null);
      await message("blank", "user", " \n\t ");
      // The first question wins, and an earlier assistant turn does not count.
      await conversation("first", null);
      await message("first", "assistant", "What should we work on?");
      await message("first", "user", "Deploy the docs site");
      await message("first", "user", "Also fix the footer");
      // One word longer than 72 characters.
      await conversation("one_word", null);
      await message("one_word", "user", "x".repeat(100));
      // The last word boundary falls in the first half.
      await conversation("early_space", null);
      await message("early_space", "user", `Fix ${"y".repeat(100)}`);

      await tx.unsafe(migration);

      const rows = await tx<
        { id: string; title: string | null; title_source: string | null }[]
      >`
        SELECT id, title, title_source FROM chat.conversations
        WHERE org_id = ${org}
      `;
      const byKey = Object.fromEntries(
        [...ids].map(([key, id]) => {
          const row = rows.find((r) => r.id === id)!;
          return [key, { title: row.title, source: row.title_source }];
        }),
      );

      expect(byKey).toEqual({
        untitled: { title: "Fix the login redirect", source: "prompt" },
        old_cut: {
          title:
            "Fix the login redirect so a person who signs in from a shared link lands",
          source: "prompt",
        },
        old_whole: {
          title: "Rename the spend waste column so a reader sees the session name for",
          source: "prompt",
        },
        renamed: { title: "Release checklist", source: "user" },
        no_question: { title: null, source: null },
        blank: { title: null, source: null },
        first: { title: "Deploy the docs site", source: "prompt" },
        one_word: { title: "x".repeat(72), source: "prompt" },
        early_space: { title: `Fix ${"y".repeat(68)}`, source: "prompt" },
      });
      for (const { title } of rows) {
        if (title !== null) expect(Array.from(title).length).toBeLessThanOrEqual(72);
      }

      throw rollback;
    }),
  ).rejects.toBe(rollback);
});
