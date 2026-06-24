-- Backfill content.generated_assets.conversation_id from the linked chat message.
--
-- Agent-tool generators (documents/markdown/archive/image.create/video.generate)
-- previously wrote assets with conversation_id = NULL because they only carried
-- ctx.messageId, never the conversation id. Those assets therefore never showed
-- up in the Conversation Files panel (conversation.files.list filters by
-- conversation_id). The persist seam now resolves the conversation from the
-- message; this migration repairs the rows that were written before that fix.
--
-- Idempotent: only touches rows that are unlinked but DO have a message_id whose
-- message resolves to a conversation. Safe to re-run.
UPDATE "content"."generated_assets" AS ga
SET "conversation_id" = m."conversation_id",
    "updated_at" = now()
FROM "chat"."messages" AS m
WHERE ga."message_id" = m."id"
  AND ga."message_id" IS NOT NULL
  AND ga."conversation_id" IS NULL;
