-- The in-app assistant's summary of the messages older than its verbatim history window, with the
-- id of the newest message it covers. NULL until a thread outgrows the window. The assistant
-- rewrites it only when enough messages have left the window since it was written, so a turn
-- reads it instead of paying for a new one (#4171).
ALTER TABLE "chat"."conversations" ADD COLUMN "history_summary" jsonb;
