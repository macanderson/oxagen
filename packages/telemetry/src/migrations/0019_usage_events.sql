-- 0019_usage_events.sql
--
-- Anonymous, OPT-OUT-by-default CLI usage telemetry (OSS trust surface — see
-- TELEMETRY.md at the repo root for the full disclosure). This is a PRODUCT
-- analytics table, distinct from the private bench-harness schema.
--
-- Hard invariant: every column here is anonymous/aggregate. NEVER add a
-- column that could carry a prompt, file path, code snippet, model slug, API
-- key, email, or any other identifying/content value. The allowlist is
-- enforced at two independent points, not just by convention:
--   - apps/cli/src/telemetry/usage.ts     (ALLOWED_KEYS — what the CLI builds)
--   - packages/telemetry/src/usage-events.ts (UsageEventPayloadSchema.strict()
--     — what apps/api's POST /v1/telemetry/usage accepts; extra/unknown keys
--     and out-of-shape values are REJECTED, not stripped)
--
-- install_id is a random UUID generated on first run and persisted in
-- ~/.config/oxagen/config.json — it identifies a CLI INSTALL, never a person.
-- Honors DO_NOT_TRACK=1 / OXAGEN_TELEMETRY=0 / `oxagen telemetry off`: when
-- opted out, the emitter never generates an id and never opens a socket.
--
-- Engine: MergeTree (pure append-only fire-and-forget; no row is ever
-- updated, so there is no need for ReplacingMergeTree's version column).
CREATE TABLE IF NOT EXISTS usage_events (
  -- Event time — stamped by the SERVER at ingest, never client-supplied, so a
  -- wrong local clock can't produce skewed or spoofed historical data.
  timestamp DateTime DEFAULT now() CODEC(DoubleDelta, ZSTD(1)),

  -- Random per-install id, generated once and persisted in
  -- ~/.config/oxagen/config.json. NOT tied to a user identity, email, or org.
  install_id UUID,

  -- Random id generated once per CLI process — groups the (at most one)
  -- event a single `oxagen` invocation emits.
  session_id UUID,

  -- CLI package version (from package.json), e.g. "2.4.10".
  oxagen_version String,

  -- Host OS family, e.g. "darwin" | "linux" | "win32".
  os LowCardinality(String),

  -- Host CPU architecture, e.g. "arm64" | "x64".
  arch LowCardinality(String),

  -- Command NAME only — e.g. "solve" | "ask" | "init" | "prompt" | "repl".
  -- NEVER the prompt text or arguments.
  command LowCardinality(String),

  -- Coarse model tier actually used — "fast" | "balanced" | "precise" |
  -- "mixed" | "". NEVER the resolved model slug (that would leak
  -- provider/version detail the allowlist explicitly forbids).
  model_tier LowCardinality(String),

  -- best-of-N fan-out width (`oxagen solve`); 0 when not applicable.
  best_of_n UInt8,

  -- 1 if the local code-graph tool was used this session, else 0.
  graph_used UInt8,

  -- 1 if the coding-agent pipeline (prompt-enhancer/judge/survey) ran, else 0.
  pipeline_used UInt8,

  -- 1 if the Ink TUI (REPL/dashboard) was rendered, 0 for a plain one-shot.
  tui UInt8,

  -- 1 if run with no interactive TTY (CI/headless/piped), else 0.
  headless UInt8,

  -- 1 if the session ran in local BYOK mode (no platform login), else 0.
  byok UInt8,

  -- JSON object mapping tool name -> invocation count for this session, e.g.
  -- {"code_graph":3,"grep":1}. Tool NAMES and counts only — the ingest route
  -- rejects any value that is not a plain string->non-negative-integer map,
  -- which makes it structurally impossible to smuggle tool arguments, file
  -- contents, or results through this field.
  tool_calls_json String CODEC(ZSTD(3)),

  -- Number of agent-loop steps/turns in the session.
  step_count UInt16,

  -- Wall-clock duration of the command/session, milliseconds.
  duration_ms UInt32,

  -- Coarse error CATEGORY when the session ended in an error, e.g.
  -- "credit_balance" | "timeout" | "network" | "" (empty = no error). The
  -- ingest route restricts this to a short lowercase identifier shape —
  -- NEVER the error message or stack trace, which could not validate.
  error_type LowCardinality(String),

  -- Terminal exit status category, e.g. "success" | "error" | "cancelled".
  exit_status LowCardinality(String)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (command, timestamp)
TTL toDateTime(timestamp) + INTERVAL 1 YEAR;
