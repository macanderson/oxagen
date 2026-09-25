-- Widen the tacho session counters and durations from int4 to bigint (#3944,
-- audit finding S-02).
--
-- The envelope allows a duration up to 2^32 - 1 ms, and ingest adds each
-- frame's duration and counts to the session row. An int4 column holds at
-- most 2^31 - 1. A value past it made Postgres refuse the update with 22003,
-- which ingest now answers 400 so one event is quarantined instead of the
-- host retrying forever. That keeps the host moving and loses the event. The
-- audit measured a daemon chain at 100 agents passing the int4 limit on
-- `api_duration_ms` in about six hours.
--
-- Every column that ingest adds to, or that holds one producer-reported
-- duration, becomes bigint. `api_error_status`, `bundle_version`,
-- `exit_status`, `context_window`, and `max_output_tokens` stay int4: each is
-- one bounded value, not a running total. The Drizzle schema declares the
-- same set as `bigint(..., { mode: "number" })`, so readers still get a
-- JavaScript number.
--
-- One ALTER TABLE per table, so each table is rewritten once. int4 to int8
-- rewrites the table under an ACCESS EXCLUSIVE lock, and ingest waits for it.
-- These tables hold one row per session, per model in a session, and per
-- command, not one per event. Defaults and NOT NULL are kept.

ALTER TABLE "tacho"."sessions"
  ALTER COLUMN "permission_mode_changes" TYPE bigint,
  ALTER COLUMN "num_turns" TYPE bigint,
  ALTER COLUMN "num_prompts" TYPE bigint,
  ALTER COLUMN "num_model_calls" TYPE bigint,
  ALTER COLUMN "num_api_errors" TYPE bigint,
  ALTER COLUMN "num_api_retries" TYPE bigint,
  ALTER COLUMN "num_tool_calls" TYPE bigint,
  ALTER COLUMN "num_tool_errors" TYPE bigint,
  ALTER COLUMN "num_tool_rejections" TYPE bigint,
  ALTER COLUMN "num_tool_asks" TYPE bigint,
  ALTER COLUMN "num_subagents" TYPE bigint,
  ALTER COLUMN "num_compactions" TYPE bigint,
  ALTER COLUMN "num_model_switches" TYPE bigint,
  ALTER COLUMN "num_notifications" TYPE bigint,
  ALTER COLUMN "num_elicitations" TYPE bigint,
  ALTER COLUMN "web_search_requests" TYPE bigint,
  ALTER COLUMN "web_fetch_requests" TYPE bigint,
  ALTER COLUMN "duration_ms" TYPE bigint,
  ALTER COLUMN "api_duration_ms" TYPE bigint,
  ALTER COLUMN "api_duration_without_retries_ms" TYPE bigint,
  ALTER COLUMN "tool_duration_ms" TYPE bigint,
  ALTER COLUMN "active_time_s" TYPE bigint,
  ALTER COLUMN "ttft_first_ms" TYPE bigint,
  ALTER COLUMN "lines_added" TYPE bigint,
  ALTER COLUMN "lines_removed" TYPE bigint,
  ALTER COLUMN "files_read" TYPE bigint,
  ALTER COLUMN "files_written" TYPE bigint,
  ALTER COLUMN "files_deleted" TYPE bigint,
  ALTER COLUMN "commands_run" TYPE bigint,
  ALTER COLUMN "network_calls" TYPE bigint,
  ALTER COLUMN "commits" TYPE bigint,
  ALTER COLUMN "pushes" TYPE bigint,
  ALTER COLUMN "pull_requests" TYPE bigint,
  ALTER COLUMN "policy_decisions" TYPE bigint,
  ALTER COLUMN "policy_denies" TYPE bigint,
  ALTER COLUMN "elevations_requested" TYPE bigint,
  ALTER COLUMN "elevations_approved" TYPE bigint,
  ALTER COLUMN "elevations_denied" TYPE bigint,
  ALTER COLUMN "elevations_expired" TYPE bigint,
  ALTER COLUMN "tokens_issued" TYPE bigint,
  ALTER COLUMN "tokens_used" TYPE bigint,
  ALTER COLUMN "checkpoint_count" TYPE bigint,
  ALTER COLUMN "telemetry_gap_count" TYPE bigint,
  ALTER COLUMN "content_frames" TYPE bigint,
  ALTER COLUMN "body_frames" TYPE bigint,
  ALTER COLUMN "tool_body_frames" TYPE bigint;

ALTER TABLE "tacho"."session_models"
  ALTER COLUMN "requests" TYPE bigint,
  ALTER COLUMN "web_search_requests" TYPE bigint,
  ALTER COLUMN "api_duration_ms" TYPE bigint;

ALTER TABLE "tacho"."session_commands"
  ALTER COLUMN "duration_ms" TYPE bigint;
