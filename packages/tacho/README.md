# @oxagen/tacho

Tacho is the Oxagen wrapper that records, gates, and evidences agents Oxagen
does not run itself: the four wrapped harnesses (Claude Code, Codex CLI,
Cursor, and Stella, ADR-101), Claude Agent SDK agents, and custom agents.
Spec: `docs/specs/tacho/spec.md`. Column contract:
`docs/specs/tacho/data-model.md`. The desktop app that installs it:
`docs/specs/oxagen-desktop/spec.html`.

This package is a leaf: no `@oxagen/*` runtime dependency, so it publishes on
its own with three executables — or, compiled, as one multi-call binary (see
[Building the executables](#building-the-executables)). The one list it shares
with the control plane by copy rather than import is `TACHO_RUNTIMES`
(`src/envelope.ts`), the values `agent.runtime` may take;
`packages/database/src/schema/tacho.ts` holds the same list for the
`tacho.sessions.runtime` CHECK, and `packages/handlers/src/tacho.runtimes.test.ts`
fails if they drift. Each wrapped harness maps to the runtime of the same
name (`contextForHarness` and `RUNTIME_FOR_HARNESS` in
`src/collector/registry.ts`): `claude-code`, `codex`, `cursor`, and `stella`.

## Boundary

- **Owns:** the `tacho/1.0` event envelope and per-session hash chain, the
  host executables (`tacho`, `tachod`, `tacho-hook`), the hook adapters and
  settings writers for each wrapped harness, the signed policy bundle's
  offline evaluation, the loopback model proxy and MCP gateway, the evidence
  primitives (Merkle, attestation, run export), and the `contextgraph-trace`
  journal.
- **Does not own:** the control-plane side of enrollment, bundles, ingest,
  and commands ([`@oxagen/handlers`](../handlers/README.md), for example
  `src/lib/tacho-host.ts`, served by [`apps/api`](../../apps/api/README.md)
  under `/v1/tacho`); the capability contracts that carry these documents
  ([`@oxagen/oxagen`](../oxagen/README.md), `src/tacho/schemas.ts`); the
  `tacho_events` store ([`@oxagen/telemetry`](../telemetry/README.md)) and the
  `tacho` Postgres schema ([`@oxagen/database`](../database/README.md),
  `src/schema/tacho.ts`); the `oxagen tacho` command wrapper
  ([`apps/cli`](../../apps/cli/README.md)); the desktop installer
  ([`apps/desktop`](../../apps/desktop/README.md)).
- **Depends on:** No `@oxagen/*` runtime dependencies. The package is a leaf
  and publishes on its own.
- **Used by:** `@oxagen/oxagen`, `@oxagen/handlers`, `@oxagen/telemetry`,
  `@oxagen/run-ledger`, `@oxagen/inngest-functions`, `apps/api`, and
  `apps/cli`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| Host and control-plane documents (bundle, claims, batch, envelope, commands) | export | `packages/tacho/src/wire.ts` | Re-exported by `packages/oxagen/src/tacho/schemas.ts` for its contracts |
| `CliDeps` | port | `packages/tacho/src/cli/deps.ts` | `defaultCliDeps`, called from `apps/cli/src/commands/tacho.ts` |
| `ControlClient` (ingest, bundle, commands endpoints) | boundary | `packages/tacho/src/host/control-client.ts` | `tachod` and `tacho` on the host, answered by `apps/api/src/app.ts` routes under `/v1/tacho` |
| Harness hook and settings writers | boundary | `packages/tacho/src/host/settings-writer.ts`, `codex-writer.ts`, `cursor-writer.ts`, `stella-writer.ts` | `tacho enroll`, `reassign`, `unenroll` |
| Cursor and Stella payload adapters | adapter | `packages/tacho/src/claude-code/cursor-adapter.ts`, `stella-adapter.ts` | `packages/tacho/src/claude-code/hook-client.ts`, for `tacho-hook --harness cursor` and `--harness stella` |
| Collector socket and loopback listeners | boundary | `packages/tacho/src/collector/server.ts`, `model-proxy-listener.ts` | `startDaemon` in `packages/tacho/src/collector/daemon.ts` |
| `TACHO_RUNTIMES` copy | boundary | `packages/tacho/src/envelope.ts` | Must equal `packages/database/src/schema/tacho.ts`. `packages/handlers/src/tacho.runtimes.test.ts` fails on drift |
| `STEERING_MANIFEST_SCHEMA` copy | boundary | `packages/tacho/src/wire.ts` | Must equal the constant in `packages/steering-assembler/src/assemble.ts` |

## Entry points

- `.` → `src/index.ts`: envelope, chain, columns, digests, ids, timestamps,
  wire documents, evidence, and session titles.
- `./claude-code` → `src/claude-code/index.ts`: hook normalizers, the
  OpenTelemetry and transcript readers, the recorder, and the hook client
  with `FAIL_OPEN_HOOK_PATHS`.
- `./collector` → `src/collector/index.ts`: the daemon and its parts.
- `./host` → `src/host/index.ts`: host primitives and settings writers.
- `./cli` → `src/cli/index.ts`: the `tacho` commands and `defaultCliDeps`.
- `./trace` → `src/trace/index.ts`: the `contextgraph-trace` journal.
- `bin`: `tacho` (`bin/tacho.mjs`), `tachod` (`bin/tachod.mjs`), and
  `tacho-hook` (`bin/tacho-hook.mjs`).

## Rules

- The package takes no `@oxagen/*` runtime dependency, including the proxy.
- A harness list in this package names all four wrapped harnesses, or its
  change says which one cannot load it and why (ADR-101).
- Hook-based control is `client_attested` (ADR-040). The tier words are
  `observe`, `harness`, `gateway`, and `contained` (ADR-095).
- The model proxy forwards prompt bodies to the vendor. Oxagen receives
  digests, counts, latency, and status, and the bodies themselves only under
  the `content_exact` retention mode (ADR-094).

## Tests

```bash
pnpm --filter @oxagen/tacho test:unit src/chain.test.ts
```

Never put `--` before the filename. Tests sit beside their modules as
`*.test.ts`. [Test fixtures and suites](#test-fixtures-and-suites) describes
the recorded sessions and the daemon end-to-end test.

## Enrolling a machine

```
oxagen login                      # once, on the machine
oxagen tacho enroll               # or: npx @oxagen/tacho enroll --token ... --org ... --workspace ...
oxagen tacho status
oxagen tacho verify               # one headless claude turn, confirmed chained
oxagen tacho reassign --workspace other   # move the host; keeps the device key
oxagen tacho unenroll
```

`enroll` generates an Ed25519 device key, calls `create_tacho_enrollment`,
writes `~/.config/oxagen/tacho/host.json` (0600) with the host API key and the
signed policy bundle, installs `tachod` as a launchd agent, a systemd user
unit, or a per-user Task Scheduler task, and merges Tacho's hook entries into
each harness named by `--harness` (`claude-code`, `codex`, `cursor`, `stella`,
or a comma list; `claude-code` by default on a fresh enrollment, the current
list on a re-apply) without touching any entry it did not write. From that point
every session of those harnesses on the machine is chained and shipped.

`reassign --org … --workspace …` points the host at another workspace or org.
The host API key is minted for the workspace at enrollment, so a move is a
revoke plus a fresh enrollment done as one step: revoke, strip the old
enrollment's hook groups from both harnesses, enroll again with `--force`
keeping the device key, the loopback port and the local bearer, so the fleet
page sees one continuous host. `reassign --harness claude-code,codex` with no
target re-enrolls in place, which is the one way to drop a wrapper: `enroll`
may add a harness on a re-apply but never silently removes one.

### More than one agent

A machine holds one enrollment per agent (ADR-202). The first enrollment lives
in the tacho root, `~/.config/oxagen/tacho` (`TACHO_HOME`). A one-time token
presented on a machine whose first enrollment is live puts its one harness in
a slot of its own, `<root>/agents/<harness>/`, and revokes nothing. A slot
holds the same per-enrollment files as the root under the same names:
`host.json`, the device key, the credential store, the WAL, the spool, and the
daemon's state (`SLOT_STATE` in `src/host/slots.ts`). A harness belongs to at
most one live slot. An operator enroll without a token still adds a harness to
the root enrollment.

One `tachod` runs a collector per slot, on that slot's ports, and one service
serves them all. The commands that act on one agent name it by harness:

```
tacho unenroll --harness codex            # remove the agent that hooks Codex
tacho unenroll --all                      # remove every agent on the machine
tacho reassign --harness codex --workspace other
tacho status --json                       # adds `enrollments`, one report per slot
```

A bare `unenroll` or `reassign` on a machine with two enrollments refuses and
lists them. `oxagen tacho unenroll` does not take `--harness` or `--all`, so
use `tacho` for these. Unenrolling one agent restarts the service for the
agents that remain. `reassign` enrolls again through the CLI session, so a
token-enrolled agent comes back under a hostname-derived agent key with no
registered agent or mandate (ADR-202, known gaps). Spec §5.8 has the full
rules.

### Codex

Codex CLI exposes a near clone of Claude Code's hook surface, so the adapter
(`src/host/codex-writer.ts`) is a settings writer and a harness tag, not a new
protocol: the same `{hooks: {Event: [{matcher, hooks: [...]}]}}` shape in
`~/.codex/hooks.json` (`CODEX_HOME`), the same five enforcement events as
command hooks, the same decision field. Codex has only `command` hooks and no
env block, so its telemetry events (`PostToolUse`, `SubagentStart`,
`SubagentStop`, `PreCompact`, `PostCompact`, `SessionEnd`, `Interrupt`) run
the hook too and there is no OpenTelemetry export. The hook command carries
`--harness codex`; sessions are labelled `agent.harness = codex`,
`runtime = codex`. `transcript_path: null` is accepted, and `unenroll` strips
the Codex hooks whether or not `host.json` still lists the harness.

### Windows

The same `~/.config/oxagen` root, so the CLI and the desktop app read one set
of files on every platform. The service is a per-user Task Scheduler task
(`schtasks /Create /SC ONLOGON /RL LIMITED`, then `/Run`) that launches a
rendered `tachod.cmd`, because Task Scheduler carries no environment. The
hook posts to `127.0.0.1:<port>` with the local bearer; the daemon skips the
Unix socket. Harnesses are found with `where claude` / `where codex`, hook
command lines are double-quoted for `cmd.exe`, and paths go through
`path.win32` so a macOS test can describe a Windows layout.

## What runs on the host

| Executable | Role |
|---|---|
| `tachod` (`src/collector/`) | The collector. Listens on a Unix socket and `127.0.0.1:<port>` with a per-install bearer; normalizes hooks, OTLP, and spool replays into per-session hash chains; appends to an NDJSON WAL; ships batches to `ingest_tacho_events` at least once with backoff and bisection; applies operator commands from the control envelope; watches for hooks removed and transcripts that advance with no hook stream; signs chain-head checkpoints with the device key; continues every chain across a restart from `daemon.json` |
| `tacho-hook` (`src/claude-code/hook-main.ts`) | The command hook Claude Code runs on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Stop`, and `SessionEnd`. Hands the payload to the daemon over the socket inside a 50 ms connect budget; if the daemon is down it decides from the cached, signature-verified bundle, spools the event, and still answers, so enforcement never depends on the daemon |
| `tacho` (`src/cli/`) | `enroll`, `status`, `reassign`, `unenroll`, `export` (tacho NDJSON, `contextgraph-trace` journal, OTLP JSON), `verify`, `daemon`, `hook`, `credential issue` (what Claude Code runs as its `apiKeyHelper`) and `credential status` |

Telemetry-only events (`PostToolUse`, `SubagentStart`, and the rest of the
25 http events) post straight to the daemon; a failure there is recorded as a
chained `telemetry_gap`, never as a blocked action. `SessionEnd` is the
exception: it runs `tacho-hook` like the enforcement events, so a session
that ends while the daemon is down is spooled and sealed when the daemon
replays the spool (`SPOOLED_HOOK_EVENTS`).

The daemon also seals a session when its harness process exits, within one
sweep (30 s). Claude Code exports its pid as `CLAUDE_PID`. For Stella and
Codex, `tacho-hook` walks up from its parent with `ps` to the harness process
and passes it as `TACHO_HARNESS_PID`. An operator's `cancel` sends that pid
`SIGTERM`. The Codex walk runs at `SessionStart` and at each prompt, stops
after 500 ms, and takes only a process named `codex` or `codex-<target>`.
A Codex hook carries no pid on Windows, or under a Codex process that serves
many threads: `app-server`, which the Codex GUI drives, `exec-server`, and
the MCP server modes. Those Codex sessions end on Codex's own `SessionEnd`,
or after six idle hours. A Cursor hook carries no pid either, because the
process that runs Cursor's hooks serves many conversations and outlives each
of them. A Cursor session ends on Cursor's own `sessionEnd`, or after one
hour with no hook (ADR-141). A session sealed that way reopens on its next
hook.

## The gateway: the loopback model proxy

`tachod` also stands between a wrapped harness and its model vendor (ADR-094).
It serves a second loopback listener, on the port after the collector's unless
`host.json` pins `model_proxy_port`, and forwards each request to the vendor.
The prompt goes from your machine to the vendor you chose. Oxagen receives a
frame for each call: digests, token counts, latency and status. The request
and response bodies go with it only when the workspace's retention mode is
`content_exact`; under `digest_only`, the default, the frame carries their
digests and no body. The vendor credential stays on the machine and is never
written to a frame or a log.

| Harness | File and key | Value written | Logins covered |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json`, `env.ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>/anthropic` | API key (`X-Api-Key`) and claude.ai subscription (`Authorization: Bearer`) |
| Codex | `~/.codex/config.toml`, top-level `openai_base_url` | `http://127.0.0.1:<port>/backend-api/codex` | API key (forwarded to `api.openai.com/v1`) and ChatGPT login (a request carrying `ChatGPT-Account-ID` is forwarded to `chatgpt.com/backend-api/codex`) |
| Stella | `$STELLA_HOME/stella.toml` (or the legacy `settings.json` when only that exists), `providers.anthropic.base_url` | `http://127.0.0.1:<port>/stella/anthropic` | Anthropic API key (`x-api-key`), which stays Stella's own: custody is never taken from Stella |

Stella's URL has a prefix of its own because Stella sends no session header.
The prefix tells the proxy the call is Stella's, and the one live Stella
session gets it; with two live Stella sessions the call is filed on the
daemon's chain. The table goes directly before Tacho's hooks block in
`stella.toml`, so each enroll's re-append of that block leaves it in place. A
`providers.anthropic.base_url` you set yourself is left alone, and `tacho
enroll` and `tacho status` say Stella's calls are not routed. Stella's other
providers (OpenRouter, Z.ai, xAI, DeepSeek, Gemini and the rest) still go
straight to the vendor, because the proxy has no upstream for them.

Cursor gets hook entries but no base URL, so its model calls go straight to
the vendor. It has no setting short of a TLS-intercepting proxy with a CA
install; `docs/audits/2026-09-21-model-gateway-arming.md` has the evidence.

The daemon reports what each of these files holds now on every health poll
(`model_base_urls`), and `list_tacho_hosts` returns it. Reverting the key is
still one edit; it is no longer a silent one.
### The credential seam: the harness holds a run token

By default `tacho enroll` also takes the vendor key out of the harness and
gives the harness a **run token** instead (ADR-143). It seals the key first
and edits the file second, so a crash between the two leaves the key where it
was. The key is sealed in
`credentials.json` under `TACHO_HOME`, AES-256-GCM under `credentials.key`
beside it, both mode 0600, and it is read by `tachod` and by nothing else. A
run token is `oxrt_<claims>.<hmac>`, signed by `run-token.key`, naming this
host, the harness, the provider and an expiry. It works at this machine's
gateway and nowhere else: the vendor refuses it, and reverting the base URL
leaves the harness with no credential the vendor accepts.

| Harness | What the harness holds | How it is refreshed |
|---|---|---|
| Claude Code | `apiKeyHelper` in `~/.claude/settings.json` runs `tacho credential issue --harness claude-code`, which prints a fifteen-minute token; `env.ANTHROPIC_API_KEY` and `env.ANTHROPIC_AUTH_TOKEN` are taken into custody, since either would win over the helper | Claude Code re-runs the helper every five minutes and on any 401 |
| Codex | `OPENAI_API_KEY` in `~/.codex/auth.json` holds a static token bounded by the enrollment's expiry | `tachod` re-mints it once an hour when it nears expiry or no longer verifies for the enrollment; `tacho enroll` does the same; it dies with the enrollment, the signing key, or a host revoke |

The proxy verifies the token, drops it, and attaches the custody credential in
the vendor's own header. A call to a brokered provider that brings its own
vendor key is refused as `foreign_credential` (a key exported in the shell
wins over the helper, and the message names the variable to unset); one with
no credential as `run_token_required`; an expired or foreign-signed token is
answered 401 so the harness fetches a new one. Every frame the proxy seals
carries `oxagen.credential_basis`, `gateway_brokered` or `harness_held`, and a
brokered call carries `oxagen.run_token_id`. Every mint is a `token_issued`
frame on the host's chain, by id and expiry, never the token.

A provider with nothing in custody is `harness_held` and crosses as before: a
claude.ai subscription has no key to take (the helper wins over it, so a
brokered host sends the token however the person signed in), and a ChatGPT
login in Codex's `auth.json` cannot be brokered, so a call carrying
`ChatGPT-Account-ID` crosses as the harness's own whatever the host holds,
and `tacho status` says so. Only `tachod` mints: when it is not running,
`tacho credential issue` prints nothing and says why, since the proxy the
token would be spent at is the daemon.
`TACHO_BROKER_ANTHROPIC_API_KEY` and `TACHO_BROKER_OPENAI_API_KEY` in the
enrolling shell hand a key to custody that was never in a harness file.
`tacho enroll --credentials passthrough` gives every key back; `tacho
unenroll` does the same first of all, then shreds the store and the signing
key. `tacho credential status` shows what is held by provider, kind, source
and date, and never the secret.

`src/host/model-credential.ts` writes and restores the harness files,
`src/host/credential-store.ts` is the custody, and `src/host/run-token.ts`
the token codec. Cursor and Stella are not brokered: neither routes its model
calls through the gateway.

`src/host/model-base-url.ts` writes and restores both, and is the contract the
CLI and the desktop app call:

```ts
applyModelBaseUrls({ home, port, harnesses });   // idempotent
restoreModelBaseUrls({ home, port, harnesses }); // byte-exact when untouched
readModelBaseUrlState({ home, port, harnesses });
```

A value you already had is displaced into a sidecar beside the file
(`.settings.json.oxagen-model-base-url.json`), restored on unenroll, and used
as the proxy's upstream meanwhile, so a harness already pointed at a corporate
gateway still reaches it. A managed settings file that sets
`ANTHROPIC_BASE_URL` wins over yours, and the state reports it as `shadowedBy`.

For Claude Code the same write also sets `env.ENABLE_TOOL_SEARCH` to `true`.
Claude Code turns its MCP tool search off behind any base URL that is not an
Anthropic host, and with it off every request carries the whole tool catalog.
On a machine with a few hundred MCP tools that is about 500k tokens before the
prompt, so the session auto-compacts three times and stops. The proxy forwards
every request byte and header unchanged, so the search is safe to keep on. A
value you already set that keeps it on (`true`, `auto`, `auto:N`) is left
alone; one apply displaced is restored on unenroll.

What standing in the path gives you:

- **Observed metering.** One `llm_call` frame per model call, `fidelity: proxy`,
  `oxagen.metering: observed`, with the vendor's own usage for Anthropic
  Messages, OpenAI Responses and Chat Completions, streamed or not. The control
  plane counts the observed frame and drops the harness's self-reported one for
  the same calls, so a routed session is counted once. Codex reports no spend
  of its own. Routed through the proxy, it has one.
- **An enforced budget.** With `budget.mode: enforced`, a session whose
  observed spend reached `budget.session_limit_usd`, or an agent whose observed
  spend for the UTC day reached `budget.daily_limit_usd` (ADR-160), has its
  next call refused with a 403 in the vendor's error shape, and the refusal is
  sealed as a `policy_decision`. A call in flight holds its ceiling (its
  request bytes as input and its output cap) against the session limit until
  it settles, so parallel calls cannot all pass on the same settled figure.
  Prices arrive in the signed bundle as `model_prices`. The mode and ceilings
  come from the agent's published `per_run_micros` and `per_day_micros`
  mandate.
- **A model allowlist.** The workspace explicitly enables lists through
  `update_tacho_session_policy`. This decision is independent of the agent's
  budget. A model outside `models.allow`, or inside `models.deny`, is refused
  with `model_not_permitted`. A trailing `*` matches by prefix. Hosts must
  advertise `models_independent` and refresh their signed bundle. The reported
  host count measures support, not confirmed receipt. While lists are enabled,
  metered requests with missing or ambiguous models are refused with
  `model_ambiguous`, including requests without a correlated session. While
  lists are off, a body that names more than one model is forwarded, and its
  frame carries `oxagen.model_ambiguous: "true"` because the model it records
  and prices against may not be the one the vendor ran.
- **A real interrupt.** `pause`, `cancel`, `kill` and a steer delivered as
  `interrupt` abort the session's in-flight model calls. A paused session's new
  calls are refused until `resume`.
- **The injection seam.** `beforeForward(request) -> request` sees each request
  before it leaves. Nothing uses it until the Phase 1 assembler exists.

A session is on the `gateway` tier only when the proxy saw a model call for it
(ADR-095). A base URL written into a config file is intent, not traffic.

**Which session a call belongs to.** In order: the `x-oxagen-session` header
(read and removed, never forwarded), the harness's own header
(`X-Claude-Code-Session-Id`, Codex's `session_id` or `conversation_id`), the
session id inside an Anthropic `metadata.user_id`, the `prompt_cache_key` of a
Responses call when it names a session the host already knows, then the one
live session of that harness when there is exactly one. A call that matches
none is sealed on the daemon's chain and marked `unattributed`.

**What fails open and what fails closed.** A fault of Oxagen's never stops a
call: an unpriced model costs the budget nothing (`observed_unpriced`), an
unreachable control plane leaves the cached bundle deciding, an unreadable
response is forwarded and recorded without usage, and a `beforeForward` that
throws or takes over 250 ms sends the original request. A decision of the
operator's always stops one: a budget at its limit, a paused or cancelled
session, a suspended or revoked host. This is separate from the hook, which
fails closed against its cached bundle. It is the `harness` tier as a whole
that is fail-open against the person at the keyboard. If the daemon is down the
harness gets a refused connection. It does not fall through to the vendor.

**Compression.** The proxy asks the vendor for `Accept-Encoding: identity` and
meters plain bytes. A response that arrives compressed anyway is passed through
as it came and metered from a decoded copy. A request body is forwarded as it
came, zstd included.

**Websockets.** An upgrade is answered `426`, which is the status Codex falls
back to HTTP on for the rest of the run.

`GET /healthz` on the proxy port and `gateway` in `tacho status` report
`{ listening, port, routes, calls_observed }`.

## Honesty

Hook-based control is `client_attested` (ADR-040 §4): the hook returns a
decision that Claude Code honours; nothing here prevents a process that
bypasses the hooks. That is why the detector exists and why the session record
carries `enforcement_tier`. Managed settings (`enroll --print-managed`) lock the
hooks for MDM-managed machines; the record is still labelled `client_attested`.

## What the daemon is today, and what it grows into

The signed bundle carries the workspace's steering and, on governed calls, the
agent's own mandate. The server compiles its active `must` and `should` context
records into `context.system` (`packages/handlers/src/lib/tacho-steering.ts`,
ADR-091), which `SessionStart` delivers. `permissions.{allow,deny,ask}` are
mapped from the agent's tool RBAC (`packages/iam`'s `resourceScope.mcp` rules)
and the workspace's external-tool decision rules onto the harness's own
permission shape (`resolveHostMandate`, `mapMandateToBundlePermissions`,
`packages/handlers/src/lib/tacho-mandate.ts`), so `PreToolUse` and Claude
Code's own permission-request event can deny a call the mandate names, not
only on host status or a paused session. What still reaches no rule here: a
decision rule that names an internal MCP server id rather than a server:tool
glob, and any business-capability rule unrelated to a tool call. Both keep
governing the in-app agent's own calls at `packages/agent/src/runtime/
mcp-rbac.ts`, just not this second, harness-facing surface (see
`tacho-mandate.ts`'s `decisionRuleToHarnessRule`). `budget.mode` is
`"enforced"` only when the agent's own definition names a `per_run_micros` or
a signed `per_day_micros` figure (`deriveBundleBudget`); otherwise it stays
`"observed"`. The loopback model proxy (`src/collector/model-proxy.ts`)
refuses a call with one of these reason codes:

| Code | When |
|---|---|
| `session_budget_exceeded` | The session's observed spend reached `budget.session_limit_usd`. |
| `daily_budget_exceeded` | The agent's observed spend for the UTC day reached `budget.daily_limit_usd` (ADR-160). The day total is this host's WAL for the day, what the proxy priced since, and the other hosts' total from the control envelope's `agent_day_spend` (`src/collector/day-spend.ts`). Signed only to a host that advertises `daily_budget`. |
| `model_not_permitted` | The workspace's armed model lists refuse the requested model (ADR-149). Signed only to a host that advertises `models_independent`. |
| `model_ambiguous` | Model lists are armed and the request names no single readable model. With lists off the call is forwarded, and a body that names more than one model marks its frame `oxagen.model_ambiguous: "true"`. |
| `session_paused`, `session_cancelled` | The operator paused or cancelled the session. |
| `host_paused`, `host_suspended`, `host_revoked` | The operator changed the host's status. |

The credential seam adds its own codes (ADR-143). Operator steer commands are the only
live text channel from the server to a running agent. Token and cost numbers for
Claude Code are the harness's own telemetry, self-reported. Codex and Stella export
none. There is no sandbox. The MCP gateway (`src/collector/mcp-gateway.ts`) is real
and server-enforced, and it is registered only into Claude Desktop. The leaf
constraint stays through every phase below: the proxy imports no `@oxagen/*`
runtime package.

## Where this package is going

Approved on 2026-09-18 (`docs/audits/2026-09-18-steering-graph-gateway-review.md`;
the design is in `docs/mission-control-spec.md` §7 and §10.5, the phases in
`docs/implementation-plan.md` §8, both in
[oxagen-roadmap](https://github.com/macanderson/oxagen-roadmap)):

- **Phase 0**, merged as PR #3289 on 2026-09-18 (ADR-091, issue #2592). The
  server compiles active `must` and `should` records into the bundle's
  `context.system`, which `SessionStart` delivers. #2592 closes when a merged
  record is seen in a real run.
- **Phase 1** (issue #3296, ADR-093 and ADR-097). `UserPromptSubmit` calls `assembleSteering` with the prompt as the
  query, under a tight timeout, and fails open. Every assembly seals a
  `steering.manifest` frame.
- **Phase 4**, in build now on branches `gateway-model-proxy` and
  `desktop-install-hardening` (issues #3299 and #3301, ADR-094). `tachod` grows
  into the gateway: a loopback model proxy (Anthropic
  Messages and OpenAI Responses passthrough with streaming, enrollment writes the
  base URL) and an MCP aggregator that re-serves the harness's existing MCP servers
  with the displace-and-restore logic in `src/host/mcp-config-writer.ts`. The
  proxy forwards prompt bodies to the vendor, and to Oxagen's servers only
  when the workspace's retention mode is `content_exact`; otherwise only their
  digests go up. The vendor credential stays on the machine. Metering
  becomes observed, `session_limit_usd` is enforced, and `interrupt` becomes real.
  Enrollment writes a base URL only after the daemon is confirmed listening, and
  unenroll restores every file it touched before it stops the daemon. Both OpenAI
  and Anthropic work through a base URL proxy, subscription logins included, and
  neither vendor's terms explicitly forbid it: validated by the maintainer on
  2026-09-18.
- **Phase 5** (issue #3300, ADR-096). `oxagen run -- <agent>` launches an agent under an OS sandbox whose
  only egress is the gateway. `contained` becomes the top word of the tier ladder:
  observe, harness, gateway, contained (ADR-095).

The order of build is Phase 0 merged, Phase 4 in build, then Phases 1, 2, 3 and
5. The epic is issue #3295. Phase 0 is on `main`, and so is Phase 4's model
proxy (`src/collector/model-proxy.ts`). The rest lands when its branch merges.

The words for the `harness` tier are "delivered", "recorded", "client-attested"
and "fail-open". Never "enforced" without the qualifier: on a governed call
(one the hook actually sees), `PreToolUse` and the permission-request event
deny a tool the mandate names, offline, from the signed bundle, even with the
daemon down. "Fail-open" describes the tier: the person at the keyboard can
remove the hook entry, disable hooks, or run another build of the harness, and
none of that is visible to Oxagen. The hook sees only the calls the harness
routes through it. It does not describe the hook process, which fails closed
against its cached bundle for a tool the mandate denies, and fails open only
for a tool the mandate never mentions (deferring to the harness's own
permission prompt) or an event that carries no tool identity to evaluate at
all (`SessionStart`, `UserPromptSubmit`, and the non-blocking record-only
events). The exact list is `FAIL_OPEN_HOOK_PATHS`
(`src/claude-code/hook-client.ts`), signed onto a bundle whose host advertises
it can parse one (`hook_fail_open`), so an operator reads the fail-open set
from the record rather than from this file. In enforce mode a stale bundle
denies non-read-only tools regardless. An unverified bundle denies them in
either mode, because the mode it claims is not signed. A bundle signed for
another host counts as unverified. Five events run as
command hooks (`COMMAND_HOOK_EVENTS`), and four of them can refuse. `Stop` is
the fifth. `SessionEnd` also runs `tacho-hook`, so it spools, and it refuses
nothing.

The tier words are fixed by ADR-095: `observe`, `harness`, `gateway`,
`contained`, computed from what was actually routed.

## Modules

| Module | What it is |
|---|---|
| `envelope.ts`, `chain.ts`, `columns.ts`, `ids.ts`, `digest.ts`, `timestamp.ts` | The `tacho/1.0` event schema, the per-session hash chain, the `tacho_events` row flattening, deterministic identity, RFC 8785 digests, the CGP timestamp profile |
| `wire.ts` | The documents that cross between host and control plane: policy bundle, enrollment claims, batch, control envelope, commands. `packages/oxagen` re-exports these for its contracts |
| `host/` | Host primitives: paths, `host.json`, the device key, offline bundle verification and the ordered `PreToolUse` evaluation over Claude Code rule syntax, the WAL, the Claude Code settings writer and the Codex hooks writer, launchd / systemd / Task Scheduler units, process scan, the control-plane client |
| `claude-code/` | Pure normalizers for hook payloads, the OpenTelemetry export, transcripts, and the headless result stream; the recorder that seals them into parent and subagent chains (restorable across restarts); the `tacho-hook` client |
| `collector/` | `handleHookEvent`, the session registry, the listener, the shipper, the command inbox, the detector, the exporters, the loopback model proxy (`model-proxy.ts`, `model-usage.ts`, `model-pricing.ts`, `model-routes.ts`), and `startDaemon` that composes them |
| `cli/` | The `tacho` commands behind an injectable `CliDeps` port; `native.ts` is the compiled binary's multi-call entry |
| `trace/` | The `contextgraph-trace` journal vocabulary, its strict parser, a port of the eight replay oracles, and the projection from Tacho events |

## Test fixtures and suites

Run one file at a time, as above. The recorded Claude Code 2.1.263
session under `fixtures/claude-code/` drives the hook contract test (every
event through `handleHookEvent`, decisions per the spec table, chains verify)
and the daemon end-to-end test (real socket and port, fake control plane,
commands, daemon-down spool and replay, restart). `src/bench/` prints the
latency figures recorded in the tacho build plan, now
`docs/oxagen/specs/tacho/plan.md` in
[oxagen-roadmap](https://github.com/macanderson/oxagen-roadmap).

## Building the executables

```
pnpm --filter @oxagen/tacho bundle          # dist-standalone/{tacho,tachod,tacho-hook}.mjs
pnpm --filter @oxagen/tacho publish:standalone
pnpm --filter @oxagen/tacho compile         # dist-bin/tacho: one self-contained executable
```

### The compiled binary

A `.dmg` cannot assume Node, so `compile` bundles the CLI to CommonJS and
embeds it in a copy of the running `node` with Node's single-executable
support (`tools/sea/compile.mjs`: blob, copy, strip the Apple signature,
postject, ad-hoc re-sign; on Windows inject only). The host node is the
runtime that ships, so each OS builds its own; there is no cross-compile.
One binary weighs about 120 MB.

The result is one multi-call binary rather than three: `tacho daemon` is the
service body and `tacho hook` the command hook, dispatched in
`src/cli/native.ts` before commander is built because the hook runs on every
tool call (cold start about 111 ms, the same process-start cost as the
separate `.mjs`; the 50 ms budget is the time allowed to *reach* the daemon).
`runtimeCommands` writes `<bin>/tacho hook` and `[<bin>/tacho, daemon]`
whenever it finds that layout — inside the desktop app bundle, in a Homebrew
prefix, or in a `TACHO_BIN_DIR` the app points it at.

### The desktop app

`apps/desktop` (Tauri 2) ships this binary and the compiled `oxagen` CLI as
sidecars, signs the machine in, enrolls it, and manages the workspace and
the wrappers by running these same commands; it owns no state of its own.
`.github/workflows/desktop.yml` builds one job per OS and attaches the
bundles and the bare binaries (with `.sha256` files) to a `desktop-v<version>`
release; `tools/packaging/` holds the Homebrew and Scoop templates that
install from those assets.

Not here yet: elevation through the control plane with Biscuit tokens (plan
PR 6), the Claude Agent SDK and custom-agent adapters (PR 5).

### Recovery during shipment and uninstall

An unreadable WAL body leaves its batch queued with exponential backoff. Command
polling, git reconciliation, and compaction continue. The daemon's compaction
scan removes abandoned UUID-suffixed body rewrite files. Read-only status and
export commands leave those files alone so they cannot interrupt a live rewrite.
A cleanup failure preserves the original evidence and surfaces the filesystem error.

Unenroll restores model URLs for the harnesses listed in valid host metadata
and any harness with a model URL receipt left by an earlier enrollment.
Missing or malformed metadata triggers a sweep of every supported model URL.
A failed restore for an enrolled harness keeps the gateway and credentials for
retry. Systemd removal retains the unit on disable failure and restores it on
reload failure. Windows process inspection errors appear in status detail while
uninstall still requires confirmation that the daemon has stopped.

Windows process-inspection failures report an unknown running state and retain the error in CLI and Desktop status. A failed orphan rewrite cleanup is reported independently, so compaction can still remove unrelated expired evidence.
