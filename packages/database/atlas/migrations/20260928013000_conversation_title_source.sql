-- A conversation's name is a subject of at most 72 characters taken from its
-- first question (#4571). title_source records who wrote the title:
--   prompt  cut from the first question when the conversation opened
--   model   written by the fast model tier after the first turn
--   user    set by a rename, or older than this column
-- The model titler replaces only a 'prompt' title, so it never overwrites a
-- name a person chose.
ALTER TABLE "chat"."conversations" ADD COLUMN "title_source" text;
ALTER TABLE "chat"."conversations" ADD CONSTRAINT conversations_title_source_check
  CHECK (title_source IS NULL OR title_source IN ('prompt', 'model', 'user'));

-- ── Backfill ──
-- Both tables force row-level security, so the updates run with the bypass
-- set for this transaction only.
--
-- A title the old code cut from the first question is either that question
-- with its whitespace collapsed, or its first 80 characters and an ellipsis.
-- Those titles, and the untitled rows, are cut again from the first question:
-- whitespace collapsed, then cut at the last word boundary that fits in 72
-- characters, or at 72 when that boundary falls in the first half. Any other
-- title was set by a rename and is marked 'user'.
SELECT set_config('app.rls_bypass', 'on', true);

UPDATE chat.conversations AS c
SET title = CASE
    WHEN length(f.tidy) <= 72 THEN f.tidy
    WHEN length(f.at_word) BETWEEN 36 AND 72 THEN f.at_word
    ELSE rtrim(left(f.tidy, 72))
  END,
  title_source = 'prompt'
FROM (
  SELECT DISTINCT ON (m.conversation_id)
    m.conversation_id,
    btrim(regexp_replace(m.content, '\s+', ' ', 'g')) AS tidy,
    rtrim(regexp_replace(
      left(btrim(regexp_replace(m.content, '\s+', ' ', 'g')), 73),
      ' [^ ]*$', ''
    )) AS at_word
  FROM chat.messages AS m
  WHERE m.role = 'user'
  ORDER BY m.conversation_id, m.created_at, m.id
) AS f
WHERE c.id = f.conversation_id
  AND f.tidy <> ''
  AND (
    c.title IS NULL
    OR c.title = f.tidy
    OR c.title = rtrim(left(f.tidy, 80)) || '…'
  );

UPDATE chat.conversations
SET title_source = 'user'
WHERE title IS NOT NULL AND title_source IS NULL;

SELECT set_config('app.rls_bypass', '', true);
