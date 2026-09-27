-- 0036_tacho_events_token_sources.sql
--
-- The token sources and the system context of a model call (#4493).
--
-- tool_definition_tokens, context_frame_tokens and steering_tokens are the
-- three token sources `cost.run_totals` sums per run. Each has a *_basis
-- column beside it: `reported` for a count the harness or the vendor stated,
-- `estimated` for one the recorder computed. An empty basis and a null count
-- mean nothing measured that source.
--
-- system_context_digest is one digest over the ordered parts of the call's
-- system context. system_context_parts lists those parts as JSON text: each
-- part's kind, name, provider, digest and token count, never its text. The
-- recorder lists them on the first call of each turn and on any call whose
-- digest differs from the last list it sent. A reader takes a frame's parts
-- from the latest frame at or before it whose digest matches and whose list
-- is set.
--
-- Why this file exists beside 0027. 0027 is GENERATED from the @oxagen/tacho
-- envelope, so adding a body member rewrites it, and a cluster that already
-- applied 0027 skips the rewritten file and never gets the columns. This one
-- carries the columns forward to every cluster bootstrapped before them.
-- Idempotent, so the order of the two on a fresh cluster does not matter.
--
-- Backfill: none. A row sealed before these members reads null counts and
-- empty strings, which a reader takes as absent.
ALTER TABLE tacho_events
  ADD COLUMN IF NOT EXISTS tool_definition_tokens Nullable(UInt32) AFTER request_effort,
  ADD COLUMN IF NOT EXISTS tool_definition_tokens_basis LowCardinality(String) AFTER tool_definition_tokens,
  ADD COLUMN IF NOT EXISTS context_frame_tokens Nullable(UInt32) AFTER tool_definition_tokens_basis,
  ADD COLUMN IF NOT EXISTS context_frame_tokens_basis LowCardinality(String) AFTER context_frame_tokens,
  ADD COLUMN IF NOT EXISTS steering_tokens Nullable(UInt32) AFTER context_frame_tokens_basis,
  ADD COLUMN IF NOT EXISTS steering_tokens_basis LowCardinality(String) AFTER steering_tokens,
  ADD COLUMN IF NOT EXISTS system_context_digest String AFTER steering_tokens_basis,
  ADD COLUMN IF NOT EXISTS system_context_parts String AFTER system_context_digest;
