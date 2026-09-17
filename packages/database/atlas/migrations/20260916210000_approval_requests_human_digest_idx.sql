-- ADR-070 (G2970): the index the standing-approval lookup needs.
--
-- An auto-approval rule with a `standingWindowMs` asks whether a PERSON
-- approved this exact call recently (lastHumanApprovalOf in
-- packages/rules/src/call-facts.ts): workspace, capability name and input
-- digest, newest resolved_at first.
--
-- approval_requests_mandate_digest_idx cannot serve that query. It is partial
-- on `mandate_id IS NOT NULL` and its second key is mandate_id, while this
-- lookup carries no mandate and keys on capability_name — so without this
-- index the query falls back to a scan of the workspace's approval history on
-- the decision path.
--
-- Partial on the same predicate as the query, which is most of the point: only
-- rows a person actually approved are indexed, so it stays far smaller than
-- the table. The DESC on resolved_at matches the ORDER BY, so the LIMIT 1 is
-- served from the index rather than by sorting.
--
-- CREATE INDEX (not CONCURRENTLY): atlas runs a migration in a transaction and
-- CONCURRENTLY cannot run inside one. approval_requests is small relative to
-- the event tables, and the same choice is made by the two indexes above it.

CREATE INDEX IF NOT EXISTS "approval_requests_human_digest_idx"
  ON "agent"."approval_requests" ("workspace_id", "capability_name", "input_digest", "resolved_at" DESC)
  WHERE resolution = 'approved' AND resolved_by_user_id IS NOT NULL AND resolved_at IS NOT NULL;
