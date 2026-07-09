# Oxagen CLI Telemetry

The `oxagen` CLI collects **anonymous, aggregate usage telemetry** to help us
understand which commands and features are actually used, how long they take,
and how often they fail — so we can prioritize fixes and improvements. This
document is the complete, exact disclosure of what that means.

**Telemetry is on by default.** It is trivial to turn off (see
[Opting out](#opting-out) below), and doing so has no effect on anything the
CLI does for you.

## The short version

- We collect **command names, durations, and coarse success/error
  categories** — never code, prompts, file contents, file paths, model names,
  API keys, or anything that identifies you personally.
- Every install gets a **random id**, generated locally and never tied to an
  email, account, or organization.
- **Opt out in one command:** `oxagen telemetry off` — or set
  `OXAGEN_TELEMETRY=0` / `DO_NOT_TRACK=1`.
- The emitter is **fire-and-forget**: it can never slow down, block, or break
  a command, even if the network is unreachable.

## Exactly what is collected

Each `oxagen` invocation emits **at most one event**, with **exactly** these
fields — nothing else is ever sent. This is not just documentation: the ingest
endpoint (`POST /v1/telemetry/usage`) validates every request against this
exact allowlist and **rejects** any request carrying an extra or unexpected
field.

| Field | Type | What it is |
|---|---|---|
| `install_id` | UUID | Random id generated on first run, persisted in `~/.config/oxagen/config.json`. Identifies an **install**, never a person. |
| `session_id` | UUID | Random id generated once per CLI process. Groups the single event one invocation emits. |
| `oxagen_version` | string | The CLI's own package version, e.g. `2.4.10`. |
| `os` | string | Host OS family — `darwin` \| `linux` \| `win32`. |
| `arch` | string | Host CPU architecture — `arm64` \| `x64` \| etc. |
| `command` | string | The command **name** only — e.g. `solve`, `ask`, `init`, `prompt`, `repl`. Never the arguments or prompt text. |
| `model_tier` | string | A coarse tier — `fast` \| `balanced` \| `precise` \| `mixed` \| `""`. Never the resolved model slug. |
| `best_of_n` | integer | The best-of-N fan-out width for `oxagen solve`; `0` when not applicable. |
| `graph_used` | 0 or 1 | Whether the local code-graph tool fired this session. |
| `pipeline_used` | 0 or 1 | Whether the coding-agent pipeline (prompt-enhancer/judge/survey) ran. |
| `tui` | 0 or 1 | Whether the interactive terminal UI (REPL/dashboard) was rendered. |
| `headless` | 0 or 1 | Whether the session ran with no interactive TTY (CI, piped input). |
| `byok` | 0 or 1 | Whether the session ran in local "bring your own key" mode (no platform login). |
| `tool_calls_json` | string | A JSON object mapping tool **name** to invocation **count**, e.g. `{"code_graph":3,"grep":1}`. Never tool arguments, file contents, or results. |
| `step_count` | integer | Number of agent-loop steps/turns in the session. |
| `duration_ms` | integer | Wall-clock duration of the command, in milliseconds. |
| `error_type` | string | A coarse error **category** when the session ended in an error — e.g. `credit_balance`, `timeout`, `network`, or `""` for no error. Never the error message or stack trace. |
| `exit_status` | string | `success`, `error`, or similar — the terminal outcome category. |

The server additionally stamps a `timestamp` at the moment the event is
received — this is **never** sent by the client, so a wrong or adversarial
local clock can never produce a spoofed or backdated event.

### Structural guarantees, not just promises

- The ingest schema uses `.strict()` validation: any field outside the table
  above causes the **entire request** to be rejected, not silently stripped.
- Every string field is shape-constrained (a UUID, a short lowercase
  identifier, or a validated tool→count JSON map) — so even a value that
  lands in an allowed field cannot smuggle free-text content. `error_type`,
  for instance, can only be a short identifier like `timeout`; an actual
  error message or stack trace fails validation and the request is rejected.
- `tool_calls_json` must parse to a flat object of `identifier: non-negative
  integer` pairs — nested objects, string values, and arbitrary keys are all
  rejected.
- The source of truth for the allowlist is
  [`packages/telemetry/src/usage-events.ts`](packages/telemetry/src/usage-events.ts)
  (server) and [`apps/cli/src/telemetry/usage.ts`](apps/cli/src/telemetry/usage.ts)
  (client) — read either file directly if you want to verify this yourself.

## What is never collected

- Code, diffs, or file contents.
- Prompts, chat messages, or any other free text you type.
- File paths, working directory names, or repository names.
- Model slugs/vendor names (only a coarse `fast`/`balanced`/`precise`/`mixed` tier).
- API keys, tokens, or any other secret.
- Email addresses, usernames, or any other personally-identifying information.
- Organization or workspace identifiers.
- IP addresses (the ingest endpoint's rate limiter inspects the request IP in
  memory to bound abuse, but the IP is never stored in a telemetry row).

## Opting out

Any one of the following fully disables telemetry — checked in this order:

1. **`DO_NOT_TRACK=1`** — the cross-tool convention
   ([consoledonottrack.com](https://consoledonottrack.com/)).
2. **`OXAGEN_TELEMETRY=0`** — an Oxagen-specific environment variable.
3. **`oxagen telemetry off`** — persists the choice to
   `~/.config/oxagen/config.json`, so it survives across shells and sessions.

```bash
oxagen telemetry off       # disable and persist
oxagen telemetry on        # re-enable
oxagen telemetry status    # show enabled/disabled, install id, ingest endpoint
```

When telemetry is disabled, the CLI does not generate an install id and does
not open a network connection for telemetry purposes — it is a complete
no-op, not a "collect but don't send" mode.

## How it's sent

- One event, sent as a single JSON POST to `<api-url>/v1/telemetry/usage`
  (`https://api.oxagen.sh/v1/telemetry/usage` by default; a self-hosted API
  URL — via `OXAGEN_API_URL` or `oxagen config api-url` — is used instead when
  configured, so a self-hosted Oxagen deployment sends telemetry to itself).
- The request is **fire-and-forget**: it is bounded by a 2-second timeout, and
  every failure mode (network error, timeout, non-2xx response) is silently
  swallowed. Telemetry can never slow down, block, or break a command.
- No session, API key, or authentication is sent or required — the endpoint
  is intentionally public and unauthenticated, since BYOK and open-source
  users may have no Oxagen account at all. It is protected instead by strict
  schema validation and a per-IP rate limit.

## Storage and retention

Events are stored in an append-only ClickHouse table (`usage_events`,
[migration `0019_usage_events.sql`](packages/telemetry/src/migrations/0019_usage_events.sql)),
partitioned by month and automatically deleted after **1 year**
(`TTL toDateTime(timestamp) + INTERVAL 1 YEAR`). There is no way to look up a
person or an organization from this data — an `install_id` is the only
identifier, and it identifies a machine's local CLI install, not a person.

## First-run disclosure

The first time telemetry sends an event, the CLI prints a short one-time
notice to stderr summarizing the above and pointing at this file and
`oxagen telemetry off`. It never prints again once shown.

## Questions

Read the source — it's the most authoritative answer:

- [`apps/cli/src/telemetry/usage.ts`](apps/cli/src/telemetry/usage.ts) — what
  the CLI builds and sends, and every opt-out check.
- [`apps/cli/src/commands/telemetry.ts`](apps/cli/src/commands/telemetry.ts) —
  the `oxagen telemetry on|off|status` command.
- [`packages/telemetry/src/usage-events.ts`](packages/telemetry/src/usage-events.ts) —
  the exact validation schema the ingest endpoint enforces.
- [`apps/api/src/routes/v1/telemetry.usage.ts`](apps/api/src/routes/v1/telemetry.usage.ts) —
  the ingest route.
- [`packages/telemetry/src/migrations/0019_usage_events.sql`](packages/telemetry/src/migrations/0019_usage_events.sql) —
  the exact table schema and retention.
