-- Conversation-level code binding: the repo + environment + agent selected on
-- the FIRST code-mode turn of a conversation, immutable thereafter. NULL for
-- non-code conversations. The chat stream route claims it exactly once
-- (UPDATE … WHERE code_binding IS NULL) and every later turn resolves the
-- coding target from the stored value, so the repo/environment/agent can
-- never drift mid-conversation.
ALTER TABLE "chat"."conversations" ADD COLUMN "code_binding" jsonb;
