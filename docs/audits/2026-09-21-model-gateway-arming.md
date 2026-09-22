# Model gateway: wired versus armed

You want to know whether the loopback model proxy actually governs a wrapped
harness's model spend today, or whether it only watches. Short answer: it
watches. Every enforcement branch in `model-proxy.ts` is real code, but the one
condition that would make budget enforcement fire is hardcoded off, and there
is no model allowlist for it to check at all. Checked at `main` `da2c3795f`,
audited from a worktree branched off `origin/main`.

## Status

The sections below are the audit as written. This block says which of its
findings still stand, at 2026-09-22.

| Finding | Where it stands |
|---|---|
| §2 `budget.mode` hardcoded `observed` | Closed, by #3710 rather than by this work. `deriveBundleBudget` sets the mode from the agent's own mandate budget, so `session_budget_exceeded` is reachable. `workspace.tacho_session_policy` holds a workspace ceiling that nothing reads. |
| §3 no model allowlist to check | Open. The parts are built and none is connected: the lists are stored, the bundle field and its feature gate exist, `refusalFor` answers `model_not_permitted`, and `unsignedBundle` signs no `models` clause, so no host is ever sent one. See "Why the clause waits" below. |
| §4 spend rollup does not double count | Stands. No change was needed. |
| §5 a reverted base URL is reported by nothing | Closed for the report. The daemon sends `model_base_urls` on every health poll, `tacho.hosts.model_base_urls` stores it, and `list_tacho_hosts` returns it. Reverting the URL is still possible; the control plane now sees the cause rather than only the tier drop. |
| §1 Cursor and Stella are never routed | Stands. The spike below says what routing each would take. |

### Why the clause waits

§3 assumed `budget.mode` would be the workspace's answer, set in the panel
beside the lists. #3710 landed first and made it the agent's: `budget.mode` is
`enforced` whenever the host's agent names a `per_run_micros` or
`per_day_micros`. Every branch in `refusalFor` hangs off that one mode, so
emitting the lists now would arm them on every workspace that had already set
an agent budget, on a word nobody typed into the gateway panel.

So the lists ship stored and unread, and the refusal is defended twice: the
control plane signs no clause, and the proxy needs `view.bundle.models` to be
present as well as the mode before either model branch opens. What is left to
decide is whose word arms them — the agent's mandate, or a switch of the
policy's own — and that is an ADR, not a line of code. Until it is answered
the panel says "Not applied", `update_tacho_session_policy` refuses
`mode: "enforced"`, and the gateway refuses no model.

### Spike: can Cursor or Stella be routed at all

PR 5 in the list below. Checked 2026-09-21 against `codex-cli 0.155.1`,
`macanderson/stella` at `crates/stella-cli`, and Cursor's published CLI
configuration page.

**Stella: yes, and one of its two knobs is writable.** `STELLA_BASE_URL` (a
global `--base-url` flag with that env var) is read by
`Config::effective_base_url` (`crates/stella-cli/src/config.rs:491`), which
returns the override ahead of the provider's own URL. That one is a flag, so
enrollment cannot write it. The writable knob is the user-scope
`providers.<id>.base_url` key in `~/.stella/stella.toml`: user scope is
trusted, and an untrusted project entry is dropped
(`crates/stella-cli/src/settings/merge.rs`). That is the same file shape
`model-base-url.ts` already edits for Codex, so PR 6 is an apply, restore and
read contract for a third harness rather than a new mechanism.

**Cursor: no.** Cursor's CLI configuration page documents no base URL, no
OpenAI-compatible endpoint, and no custom provider. The only override it
documents is the general `HTTP_PROXY` / `HTTPS_PROXY` pair with
`NODE_EXTRA_CA_CERTS`, which is a TLS-intercepting proxy for all of Cursor's
traffic and needs a CA installed on the machine. That is a different
mechanism, it needs the operator's consent to intercept everything, and
Cursor calls its own backend rather than the vendor, so the frames would not
be vendor-shaped even if it worked. Do not build PR 6 for Cursor on this
evidence.

## 1. Which harnesses actually route through the proxy

`tacho enroll` writes hook entries for up to four harnesses (`--harness
claude-code,codex,cursor,stella`), but it writes the model base URL for only
two of them.

`packages/tacho/src/cli/enroll.ts:1053-1056` filters the enrolled harness list
down before it ever calls the base-URL writer:

```ts
const routed = harnesses.filter(
  (harness): harness is ModelBaseUrlHarness =>
    harness === "claude-code" || harness === "codex",
);
```

`ModelBaseUrlHarness` (`packages/tacho/src/host/model-base-url.ts:67`) is
`"claude-code" | "codex"`, full stop. Cursor and Stella get their hook entries
(`host/cursor-writer.ts`, `host/stella-writer.ts`) so their tool calls and
lifecycle events are still chained and shipped, but nothing ever writes a base
URL for them, and `model-routes.ts` has no route for either vendor's traffic
under a Cursor- or Stella-only path. Their model calls go straight to the
vendor. This is confirmed, not inferred: `packages/tacho/README.md`'s gateway
table (lines 96-98) lists exactly two rows, Claude Code and Codex.

For Claude Code, enrollment writes `env.ANTHROPIC_BASE_URL` in
`~/.claude/settings.json` to `http://127.0.0.1:<port>/anthropic`
(`model-base-url.ts:114-138`). For Codex, it writes the top-level
`openai_base_url` key in `~/.codex/config.toml`
(`model-base-url.ts:118,132-139`), never an environment variable.

I checked the installed Codex build on this machine: `codex-cli 0.155.1`
(`/opt/homebrew/bin/codex`). Its own binary carries `openai_base_url` as a
field of its `ConfigToml` struct (confirmed by string-scanning the binary), so
the installed version reads the TOML key the repo's writer targets. It does
**not** read an `OPENAI_BASE_URL` environment variable for this purpose — that
is not the mechanism Codex or this codebase use; the config key is. Framing
the question as an env var would be answered "no," and that would be the wrong
question. The right one, "does Codex honor the `openai_base_url` config key,"
is yes, on the version installed here.

## 2. What sets `budget.mode` to `enforced`, and what happens mid-stream

Nothing does. `unsignedBundle()` in
`packages/handlers/src/lib/tacho-host.ts:337` hardcodes it:

```ts
budget: { mode: "observed" as const },
```

There is no column read, no workspace setting, no code path anywhere in
`packages/handlers` that ever produces `"enforced"`. `router.policy.set`
(`packages/oxagen/src/contracts/router.policy.set.ts`) is a different system:
it governs the Verified-Outcome Market Router's mode (`off` / `shadow` /
`enforce`), success threshold and tier escalation for the in-app assistant's
model selection. It has no field for a wrapped harness's session budget and
writes to a different table. The two "enforce" words name unrelated
mechanisms.

The refusal logic that would fire on `enforced` is real and already shipped:
`model-proxy.ts:472-483` compares a session's observed spend against
`budget.session_limit_usd` and refuses with `session_budget_exceeded` when the
comparison would trip. It has simply never been given a bundle where
`budget.mode` is anything but `"observed"`, so that branch is dead code in
production.

Mid-stream: the budget is checked once, at admission, before the upstream
request opens (`model-proxy.ts:603`, before `forward()` reaches
`upstreamReq.end(body)` at line 1008). Once a call is admitted it runs to
completion even if the session crosses its limit while the response streams.
This is a documented design choice, not a gap: the module's own header
comment (`model-proxy.ts:57-60`) states it plainly — cutting a stream in half
to save its last tokens would cost the operator the whole call, so the
proxy never re-checks mid-flight. Only the session's *next* call is refused.

## 3. Can the proxy enforce a model allowlist today

No, and there is no policy for it to enforce even if it could. `refusalFor()`
(`model-proxy.ts:444-485`) checks exactly four things: host status, session
cancellation, session pause, and the budget. It never inspects `route.provider`
or the model name. The model is not even known yet at that point in the
call: `requestModel` is computed at `model-proxy.ts:674-678`, after
`refusalFor()` has already run and, if it refused, already returned at line
640. An allowlist check bolted onto today's code would silently never fire for
a refusal, because the model string does not exist yet at the point the
refusal decision is made.

There is also no wire concept of "the model the router policy permits."
`policyBundleSchema` (`packages/tacho/src/wire.ts:420-426`) carries `budget`
and, optionally, `model_prices` (a price list, gated behind
`BUNDLE_FEATURE_MODEL_PRICES`, used only for costing — an unpriced model is
still forwarded, `cost_basis: "observed_unpriced"`). Nothing in the bundle
says which models are allowed. `router.policy.get`/`.set`
(`packages/oxagen/src/contracts/router.policy.*.ts`) is, again, the market
router's mode and threshold, not a model allow/deny list — so "the model the
router policy does not permit" names a policy that does not exist yet.

**The smallest change that makes the proxy refuse a disallowed model** is
three pieces, in order:

1. Move the model-name read (`leadingModel`/`json()?.model`, currently at
   `model-proxy.ts:674-678`) ahead of the `refusalFor()` call at line 603, so
   the refusal check can see it.
2. Add an optional `models: { allow: string[] }` (or `deny`) object to
   `policyBundleSchema`, gated behind a new `BUNDLE_FEATURE_MODEL_ALLOWLIST`
   flag, following the exact rollout pattern `gateway_tools` and
   `model_prices` already use (`tacho-host.ts:225-249`,
   `wire.ts:449-497`) — required because the schema is `.strict()` and an
   older daemon would reject the whole bundle otherwise.
3. Add a fifth branch to `refusalFor()` — `model_not_permitted` — that checks
   `requestModel` (and `route.provider`) against that list before the budget
   check, mirroring the existing four branches.

That is an implementation-sized change (see PR 4 below). What it depends on,
and cannot substitute for, is a maintainer decision on what "permitted" means:
a new field on `router.policy.set`, a separate per-workspace model allowlist,
or something else. Coding the check against a policy field that does not
exist is not possible; that decision blocks PR 4, not the audit.

## 4. Where proxied spend lands, and whether it double-counts

Proxied spend and self-reported spend land in the same three places, and all
three de-duplicate the same way, so the Spend page does not double count.

- **The session budget counter.** `usageCountedEvents()`
  (`packages/handlers/src/tacho.events.ingest.ts:250-266`) drops every
  self-reported `llm_call` for a session once that session has one
  proxy-observed call (`isObservedModelCall`, lines 221-228, requires
  `source: "collector"`, `fidelity: "proxy"`, and the
  `oxagen.metering: observed` attribute — none of which a process holding
  only the local bearer can forge). `foldDelta` (line 293) and `rollupModels`
  (line 1779) both consume the deduplicated `counted` list, not the raw
  batch.
- **The billing spend counter.** `recordSpend()`
  (`packages/billing/src/spend-counter.ts:39`) is called once per accepted
  batch with `delta.totalCostMicros` (`tacho.events.ingest.ts:1525-1526`),
  which already reflects the same dedupe. This is the identical counter the
  `@oxagen/ai` gateway writes to for the in-app assistant's own spend
  (`spend-counter.ts:5-11`), so a wrapped session and an assistant turn share
  one ledger by construction, not by later reconciliation.
- **The Spend page's `cost.run_totals`/`cost.daily_totals` rollup.** This is a
  third, independent pipeline (ClickHouse, not the Postgres path above), and
  it has its own dedupe rather than trusting the first two:
  `packages/telemetry/src/cost-frames.ts:105` filters on
  `attrs[duplicateAttr] = ''`, where `duplicateAttr` is
  `oxagen.llm_call_duplicate_of`, a stamp the host's own recorder writes
  (`packages/tacho/src/claude-code/recorder.ts`, `llm-call-dedupe.ts:1-3`) on
  whichever sighting of a call (OTel, transcript, or proxy) is not the one
  being priced. All three readers — the session fold, the spend counter, and
  the ClickHouse rollup — agree on which sighting wins, and the agreement is
  enforced by one shared rule (`countsLlmCallUsage` in `@oxagen/tacho`), not
  by three engineers keeping three lists in sync.

I found no double-count path. The one caveat: this dedupe keys on
`request_id`/`message_id` matching within a session. A call that fails before
the vendor returns a request id, on both the proxy sighting and the harness's
own sighting, would not join, and could in principle be counted from both
sides. I did not find evidence this happens in practice, and it is a narrow
edge case, not a gap in the design.

## 5. What a laptop user can do to bypass the proxy, and what the record shows

| Bypass | What it takes | What the record shows |
|---|---|---|
| Edit `~/.claude/settings.json` or `~/.codex/config.toml` after enrollment, pointing the base URL back at the real vendor or removing it | One file edit, no restart needed | The session's tier stops reaching `gateway` (ADR-095 rule, `tacho.events.ingest.ts:603-636`: `modelRouted` goes false with no proxy frame to set it true). The control plane sees a tier drop but not a stated cause — `touchHost`'s daemon payload (`tacho-host.ts:531-548`) carries version, uptime, spool depth and hook health, never model-base-url state. An operator has to run `tacho status` locally to see `ours: false` or `shadowedBy` |
| Add or already have a managed settings file that also sets `ANTHROPIC_BASE_URL` | Nothing the user has to do; managed settings win by policy | Same as above: reported locally as `shadowedBy` (`model-base-url.ts:99`) via `tacho status`, never pushed to the control plane |
| Call the vendor API directly (curl, a raw SDK client, a second tool) instead of through the enrolled harness | A model key and any HTTP client | Nothing. This traffic never touches loopback, so no frame, no digest, no tier change — fully invisible |
| Kill `tachod` | `kill` the daemon process | For Claude Code and Codex, this is self-defeating on its own: the base URL still points at the now-dead loopback port, so the harness's next model call gets connection-refused rather than silently reaching the vendor (there is no fallback URL). It only becomes a silent bypass combined with reverting the base URL first. Hook-tier enforcement (`PreToolUse` etc.) keeps deciding from the last cached, signature-verified bundle either way (`packages/tacho/README.md`, the `tacho-hook` row) |
| Set Claude Code's `disableAllHooks` | One settings key | Telemetry and hook-tier enforcement (pause/cancel/deny checks on tool use) stop. Model traffic is unaffected either way, since the proxy sits at the network layer, not the hook layer — it keeps metering unless the base URL is also reverted |
| Run the harness under Cursor or Stella | Nothing — this is the default, not an evasion | Never routed in the first place (Q1). Indistinguishable, from the record, from a Claude Code or Codex session where the base URL was reverted |

The pattern across every row: the proxy's own presence is well-defended (a
forged `oxagen.metering: observed` attribute cannot be minted from outside
the collector), but *whether the harness was pointed at the proxy at all* is
enforced by nothing and reported to the control plane by nothing. The tier
field is the only signal, and it is a symptom, not a cause.

## Harness × enforcement matrix

As audited, before the changes in the status block above:

| Harness | Metered (observed) | Enforced (budget/allowlist) | Bypass path |
|---|---|---|---|
| Claude Code | Yes, once enrolled and the base URL holds | No — `budget.mode` is hardcoded `observed`; no allowlist exists | Revert `env.ANTHROPIC_BASE_URL`; a managed settings file; call the vendor directly |
| Codex | Yes, once enrolled and the base URL holds | No, same as Claude Code | Revert `openai_base_url`; call the vendor directly |
| Cursor | No — never routed | No | None needed; this is the default path |
| Stella | No — never routed | No | None needed; this is the default path |

As it now stands:

| Harness | Metered | Enforced | Bypass path |
|---|---|---|---|
| Claude Code | Yes, once enrolled and the base URL holds | Yes, when the workspace sets `enforced` and the host advertised `models`. The session ceiling needs no advertisement. | Revert `env.ANTHROPIC_BASE_URL`, which the host now reports; a managed settings file, also reported; call the vendor directly, still invisible |
| Codex | Yes, once enrolled and the base URL holds | Yes, same as Claude Code | Revert `openai_base_url`, now reported; call the vendor directly |
| Cursor | No, never routed | No | None needed. No base URL exists to write (spike above). |
| Stella | Anthropic provider: yes, once enrolled and the base URL holds (PR #3730, 2026-09-22). Other providers: no, never routed. | Anthropic provider: the session ceiling, as for Claude Code. Other providers: no. | Revert `providers.anthropic.base_url`, now reported; set it before enrolling, which enroll leaves alone and reports; use a provider the proxy has no upstream for; call the vendor directly |

## Ordered PR list

1. **Shipped. Source `budget.mode`/`session_limit_usd` from a real
   per-workspace setting into the signed bundle.** New capability contract (mirroring
   `workspace.budget_policy.*`, but for Tacho sessions, not per-turn assistant
   spend) plus wiring `unsignedBundle()` to read it instead of the literal.
   Moves reliability: the refusal branch that already exists starts doing
   something. **3 days.**
2. **Shipped, on Spend rather than Organization. UI to set that budget**
   (mode, `session_limit_usd`, and the model lists from PR 3).
   GAP-INVENTORY §9 already lists "Set model route" as Missing; this is the
   adjacent gap the same page should close. Depends on PR 1's contract.
   **2 days.**
3. **Shipped, under a stated assumption. Decide and encode what "a model the
   router policy does not permit" means.** This is a design decision before it is code: extend
   `router.policy.set`/`.get` with an explicit model allow/deny list, or a
   separate workspace-level allowlist, is the maintainer's call, not an
   implementation detail. Sizing the decision + schema/contract work once
   made: **3 days.**

   The assumption taken: a separate workspace-level list, not a field on
   `router.policy.set`. The market router picks a model for Oxagen's own
   assistant turn, which is a different decision with a different enforcer,
   and hanging a wrapped-harness allowlist off it would make one word govern
   two mechanisms that can disagree. The list lives on
   `workspace.tacho_session_policy` beside the session ceiling, and one mode
   arms both. Change it if the maintainer decides otherwise; nothing outside
   that table and the `models` bundle field would move.
4. **Shipped. Wire the allowlist check into the proxy**, per the three-piece change in
   Q3: reorder `forward()` to resolve the model name before `refusalFor()`,
   add the `models` bundle field behind a new `BUNDLE_FEATURE` flag, add the
   `model_not_permitted` refusal branch. Depends on PR 3 landing first.
   **2 days.**
5. **Done, in the spike above. Can Cursor's or Stella's model traffic be
   routed at all.**
   Neither has a documented base-URL or proxy override in this codebase
   today (unlike Claude Code and Codex, which vendor-document theirs).
   Establish whether either exposes an equivalent knob before committing to
   build it. **1 day.**
6. **Built for Stella's Anthropic provider in PR #3730 (2026-09-22); the live-session check in #3717 is still open.** Stella gets its own `/stella/anthropic` prefix, because it sends no session header. Its OpenAI-compatible providers stay direct, because the proxy has no upstream for them. Route Stella through the proxy. PR 5 found the
   knob: the user-scope `providers.<id>.base_url` key in
   `~/.stella/stella.toml`, the same TOML shape `model-base-url.ts` already
   edits for Codex. It needs `ModelBaseUrlHarness` widened, a route in
   `model-routes.ts` for whatever dialect the workspace's provider speaks,
   and the enroll filter at `enroll.ts:1053` opened to it. **2-3 days.**
   Cursor is not in this PR: PR 5 found no base URL to write, and the
   TLS-intercepting alternative is a different decision with a CA install
   behind it.
7. **Shipped. Report model-base-url drift to the control plane.** Add
   `model_base_urls` (mode, `ours`, `shadowedBy`) to the daemon health
   payload `touchHost()` already reads, so a reverted base URL shows as a
   stated cause instead of a bare tier drop. Moves reliability and
   maintainability: today the only diagnostic is a laptop-local `tacho
   status`. **2 days.**

No PR is needed for the spend-rollup dedupe (Q4): it is already correct, at
all three layers, verified above.
