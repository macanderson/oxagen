# PostHog Product Analytics

Archived spec & plan — status: not started (audited 2026-07-03).

> **Status: Not started** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The PostHog Product Analytics spec is a well-drafted 378-line requirements document (June 2026, marked "Draft for review") that defines a comprehensive analytics system with identity modeling, event taxonomy, dashboards, GDPR integration, and feature flags. No implementation has shipped: no @oxagen/analytics package exists, no PostHog SDKs are imported anywhere, no event capture code is present, proxy.ts lacks a reverse proxy, the GDPR erasure flow does not attempt PostHog deletion (marked "pending" in the SOP), and git history shows zero analytics-related work.

**Implementation evidence**

- docs/specs/analytics/posthog-product-analytics-requirements.md — comprehensive 378-line spec with detailed requirements across 13 sections; status marked Draft for review
- docs/specs/gdpr/sop-data-erasure.md — PostHog person-delete listed as pending in downstream systems table; privacy/erasure.execute Inngest function contains no PostHog integration
- apps/app/src/proxy.ts — reverse proxy exists but handles only auth redirects and URL rewrites; no PostHog /ingest/ rewrite to us.i.posthog.com
- packages/handlers/src/privacy.data.erase.ts — handler dispatches erasure Inngest job with no PostHog deletion call
- Git log — zero commits mentioning PostHog or product analytics implementation since spec added June 20, 2026

**Known gaps at time of archive**

- @oxagen/analytics package (with captureServer, useAnalytics hook, typed event registry)
- Server-side event capture via posthog-node
- Client-side analytics provider via posthog-js
- Identity model wiring (identify/reset/groupIdentify for org and workspace groups)
- Event catalog implementation (50+ events across auth, onboarding, engagement, billing, friction domains)
- Reverse proxy for PostHog ingestion (/ingest to us.i.posthog.com)
- Consent gating and PII masking on replay
- Eight dashboards (acquisition, activation, retention, revenue, engagement, friction, conversion, adoption)
- Feature flags and experiments with exposure capture
- Session replay (masked)
- GDPR person-delete webhook integration (blocking release per spec section 11)

**Source documents** (archived verbatim below)

- `docs/specs/analytics/posthog-product-analytics-requirements.md`

## Document — `posthog-product-analytics-requirements.md`

## Product Analytics Requirements — PostHog

**Status:** Draft for review
**Owner:** Mac Anderson
**Provider:** PostHog Cloud (US region — `https://us.i.posthog.com`)
**Last updated:** 2026-06-14
**Related:** `docs/gdpr/sop-data-erasure.md` · `docs/compliance/` · ADR (to be filed: "ADR — PostHog product analytics")

---

### 1. Purpose & goals

We embed product-usage analytics so we can **understand our customers** — what they use heavily, what they ignore, where they get stuck, and what drives conversion to paid plans. PostHog is the system of record for product behavior.

Concretely, the instrumentation must answer:

- **Acquisition** — where do signups come from, and which sources convert to active orgs?
- **Activation** — what fraction of new orgs reach the "aha" moment (first successful agent run), and how long does it take?
- **Engagement** — which features are used, by whom, how often; what is the DAU/WAU/MAU and stickiness (DAU÷MAU)?
- **Retention** — do users/orgs come back? Cohorted N-day and N-week retention.
- **Revenue / conversion** — what behaviors precede an upgrade from Free → Build/Scale/Enterprise; where do paid funnels leak; what is credit consumption behavior?
- **Friction** — where do users hit errors, rage-click, abandon forms, or churn?

#### Non-goals (explicit scope boundary)

- **PostHog is product analytics, not system telemetry.** Runtime execution events, token usage, tool-call traces, and LLM metering stay in **ClickHouse** via the existing `invoke()` chokepoint. Do not duplicate high-cardinality machine telemetry into PostHog (cost + noise). The bridge between them is **identity** (the same `org_id`/`workspace_id`/`user_id`), not event duplication.
- PostHog is **not** the billing source of truth — Stripe is. Revenue events in PostHog are for behavioral analysis, reconciled from Stripe, never authoritative.
- PostHog is **not** an application database. No transactional reads/writes depend on it.

---

### 2. Architecture requirements

#### 2.1 Single analytics chokepoint (`@oxagen/analytics`)

Mirror the existing "single AI chokepoint" pattern. **All** product-analytics emission goes through one workspace package, `@oxagen/analytics`, which wraps the PostHog SDKs. No app, route, or component may import `posthog-js` / `posthog-node` directly.

The package must expose:

- `captureServer(event, { distinctId, groups, properties })` — server-side capture (wraps `posthog-node`).
- A thin client provider + `useAnalytics()` hook for the browser (wraps `posthog-js`), exposing `capture`, `identify`, `group`, `reset`, `isFeatureEnabled`, `getFeatureFlag`.
- `identify` / `group` / `alias` / `reset` helpers with the Oxagen identity model baked in (§3).
- A **typed event registry** — every event name and its required property shape defined in one place (TypeScript discriminated union). Calling `capture` with an unregistered event or wrong property shape is a type error. This is the taxonomy-enforcement mechanism (§5).

Rationale: one boundary gives us consistent identity, group attachment, PII scrubbing, naming enforcement, batching, and a single place to disable analytics for self-hosted/air-gapped customers.

#### 2.2 Server-side first

Default to **server-side capture** (`posthog-node`) for any event that represents a state change we can observe on the backend (signup completed, org created, subscription changed, agent run completed, credits purchased). Server-side events are:

- Resistant to ad blockers and `Do Not Track`.
- Trustworthy for funnels and revenue (the client can't drop or spoof them).
- Naturally co-located with the `invoke()` boundary where authz/org context already exists.

Use **client-side capture** (`posthog-js`) for UI-only signals the server can't see: pageviews, autocapture (clicks/inputs), session replay, feature-flag exposure, rage clicks, form-field interactions, surveys.

For events that matter to revenue/activation, **emit server-side even if a client event also exists**, and de-duplicate in analysis via a canonical `$event_source` property (`client` | `server`).

#### 2.3 Reverse proxy (anti-adblock) — required

Route PostHog ingestion through a first-party reverse proxy so events aren't blocked by content blockers and third-party cookie restrictions. Proxy `/ingest/*` (or similar) on the app domain to `us.i.posthog.com` (and the assets host). Configure `posthog-js` with `api_host` = our proxy path and `ui_host` = `https://us.posthog.com`. Document the rewrite in `apps/app` request handling (`proxy.ts` is edge-safe; a rewrite rule is appropriate there, or a Next.js rewrite).

#### 2.4 Initialization & config

- Initialize `posthog-js` once, in a client provider mounted high in `apps/app` layout, gated behind consent (§9) and the `NEXT_PUBLIC_POSTHOG_*` env vars.
- Initialize `posthog-node` as a long-lived singleton per server runtime; **flush on shutdown** (and in serverless/Fluid Compute, `await` flush or use `waitUntil` so events aren't dropped when the function suspends).
- All keys via env, never hard-coded. Required env (per environment — dev/preview/prod):
  - `NEXT_PUBLIC_POSTHOG_KEY` (project API key, client)
  - `NEXT_PUBLIC_POSTHOG_HOST` (proxy path)
  - `POSTHOG_API_KEY` (server, project key)
  - `POSTHOG_HOST` (`https://us.i.posthog.com`)
  - `POSTHOG_PERSONAL_API_KEY` (optional — for build-time taxonomy sync / management API; never shipped to client)
- **Separate PostHog projects per environment** (dev, preview, prod) so test traffic never pollutes production metrics. Never send dev/CI events to the prod project.
- Disable capture entirely in test/CI and for E2E runs (`opt_out_capturing` or a no-op driver) so Playwright traffic doesn't generate events.

---

### 3. Identity & group model

#### 3.1 Persons

- **Anonymous → identified.** Before login, PostHog assigns an anonymous `distinct_id`. On signup/login, call `identify(userId)` so the pre-signup anonymous session is stitched to the person. Use `alias` only where `identify` can't bridge (rare). Call `reset()` on logout to start a fresh anonymous id (prevents two users sharing a device from merging).
- **Canonical `distinct_id` = our `user_id`** (the Postgres user UUID / public_id — pick one and keep it stable forever). Never use email as the distinct id.
- **Person properties** (set via `identify` / `$set` and `$set_once`):
  - `$set_once`: `signup_at`, `signup_source`, `initial_utm_*`, `initial_referrer`.
  - `$set`: `email` (if consent allows — see PII rules), `name`, `created_at`, `role` (org role), `is_internal` (true for `@oxagen.ai` / staff — used to exclude internal traffic), `email_verified`, `last_active_at`, `plan` (denormalized current org plan for convenience), `locale`, `timezone`.
- **Internal-traffic exclusion is mandatory.** Tag staff (`is_internal: true`) and create a saved cohort that every production dashboard filters out by default.

#### 3.2 Groups (B2B multi-tenancy) — required, not optional

Enable **Group Analytics** with two group types matching our tenancy:

- **`organization`** — group key = `org_id`. The unit of revenue and account-level retention.
- **`workspace`** — group key = `workspace_id`. The unit of day-to-day product work.

Requirements:

- Every authenticated event **must** attach both groups (`groups: { organization: org_id, workspace: workspace_id }`). The `@oxagen/analytics` server helper should pull these from the request/`invoke()` context automatically so callers can't forget.
- **Group properties** kept current via `groupIdentify`:
  - `organization`: `name`, `slug`, `plan` (Free/Build/Scale/Enterprise), `created_at`, `member_count`, `mrr`, `credit_balance`, `credit_plan_source`, `is_paying`, `trial_status`, `industry`/`size` (if collected), `billing_status`.
  - `workspace`: `name`, `slug`, `org_id`, `created_at`, `connector_count`, `agent_count`.
- Define **org-level and workspace-level retention/funnels** in PostHog (B2B retention is account-based: an org is "retained" if *any* member returns).

#### 3.3 Identity hygiene

- Stable ids only; never recycle a `distinct_id` or group key.
- One person = one human. Service accounts / API keys get `is_internal`-style tagging or are excluded.
- Respect the GDPR erasure SOP: a person-delete webhook/flow must remove the PostHog person on account deletion (the SOP currently lists this as **pending** — this spec makes wiring it a release requirement, see §9).

---

### 4. Capture modes & coverage

| Mode | Use for | SDK |
|---|---|---|
| **Manual events** | Lifecycle, activation, conversion, feature-adoption, friction (the catalog in §6) | both |
| **Autocapture** | Clicks, inputs, form submits, pageviews — broad coverage without per-element code | `posthog-js` |
| **Pageviews / pageleaves** | SPA route changes (capture manually on App Router navigation, since autocapture pageview needs history hooks) | `posthog-js` |
| **Session replay** | Qualitative debugging of friction; **masked** (§9) | `posthog-js` |
| **Feature flags** | Gating + experiment exposure | both |
| **Surveys** | In-product NPS / PMF / churn / feedback | `posthog-js` |
| **Exceptions** | Client + server error tracking (`captureException`) | both |

**Autocapture + manual is the industry norm:** autocapture gives you breadth (you can answer questions you didn't pre-instrument), manual events give you the reliable, well-named "spine" funnels and revenue depend on. Define both.

---

### 5. Event taxonomy & naming standard

A governed naming convention is what separates a maintainable analytics implementation from an unusable swamp of `Button Clicked 2 (final)`.

#### 5.1 Naming convention

- **Format:** `domain.object_action`, lower snake_case within segments, dot-namespaced by domain. Past-tense action verbs (the event already happened).
  - ✅ `onboarding.user_info_completed`, `agent.run_completed`, `billing.subscription_upgraded`, `connector.connected`
  - ❌ `ClickSignup`, `userSignedUp`, `agent run`, `Did Thing`
- This honors the existing draft (`onboarding.started`, `onboarding.user_info.started`); we standardize the trailing segment to `object_action` so the **object** (what) and **action** (verb) are unambiguous and consistent across domains.
- **Domains** (the namespace prefix): `auth`, `onboarding`, `org`, `workspace`, `agent`, `chat`, `connector`, `knowledge`, `automation`, `billing`, `settings`, `collaboration`, `nav`, `friction`, `marketing`.
- **Properties:** snake_case keys; booleans prefixed `is_`/`has_`; durations in `_ms` or `_seconds` (state the unit in the key); ids suffixed `_id`; enums documented with their allowed values.
- **Reserved:** never shadow PostHog's `$`-prefixed properties unless intentionally setting them (`$set`, `$set_once`, `$current_url`, etc.).

#### 5.2 Governance (required)

- **The typed event registry in `@oxagen/analytics` is the single source of truth.** No event ships without an entry: name + TypeScript property schema + one-line description + owner domain. CI fails if `capture` is called with a string literal not in the registry (lint rule or type error).
- **Every event documents:** what it means, when it fires (exact trigger), required vs optional properties, whether it's client/server/both, and whether it's an activation/conversion "key event."
- Use PostHog's **data management** tags: mark verified events, deprecate (don't delete) retired ones, hide internal/debug events from the insights picker.
- **Property dictionary:** maintain a shared list of standard properties (§7) reused across events so `plan`, `org_id`, etc. always mean the same thing and have the same type.
- Review taxonomy changes like schema changes — additive by default, deprecate before removing.

---

### 6. Event catalog (the spine)

Organized by lifecycle (AARRR + friction). This is the **minimum industry-par set**; ✦ marks **key/activation/conversion events** that anchor funnels and must be server-side and reliable. Properties listed are event-specific; every event also carries the standard properties in §7.

#### 6.1 Acquisition & auth

| Event | Trigger | Key props | Src |
|---|---|---|---|
| `marketing.page_viewed` | Public/marketing pageview | `path`, `utm_*`, `referrer` | client |
| `auth.signup_started` ✦ | Signup form opened/first field | `method` (password/google/github) | client |
| `auth.signup_completed` ✦ | Account created | `method`, `email_verified` | server |
| `auth.signup_failed` | Signup error | `method`, `reason` | both |
| `auth.email_verification_sent` | Verification email dispatched | — | server |
| `auth.email_verified` | Email confirmed | `time_to_verify_seconds` | server |
| `auth.login_succeeded` | Successful login | `method` | server |
| `auth.login_failed` | Failed login | `method`, `reason` | both |
| `auth.password_reset_requested` | Reset requested | — | server |
| `auth.logout` | User logs out | — | client |
| `auth.invite_accepted` ✦ | User joins via org invite | `org_id`, `inviter_id`, `role` | server |

#### 6.2 Onboarding (expands the original draft)

| Event | Trigger | Key props | Src |
|---|---|---|---|
| `onboarding.started` ✦ | Onboarding flow entered | `entry_point` | both |
| `onboarding.user_info_started` | User-info step opened | — | client |
| `onboarding.user_info_completed` | User-info step submitted | `role`, `use_case`, `referral_source`, `company_size` | both |
| `onboarding.org_created` ✦ | First org created | `org_id`, `slug` | server |
| `onboarding.workspace_created` ✦ | First workspace created | `workspace_id` | server |
| `onboarding.connector_prompted` | Connect-data step shown | — | client |
| `onboarding.connector_connected` ✦ | First connector linked in onboarding | `connector_type` | server |
| `onboarding.first_ask_submitted` ✦ | First message sent to the agent | — | server |
| `onboarding.step_skipped` | Any step skipped | `step`, `step_index` | client |
| `onboarding.completed` ✦ | Onboarding finished | `steps_completed`, `total_duration_seconds` | both |
| `onboarding.abandoned` | Flow exited before completion | `last_step`, `step_index` | client |

Define onboarding as a **PostHog funnel** (`started → user_info_completed → org_created → first_ask_submitted → completed`) with step conversion + time-to-convert, plus a **conversion window** appropriate to the flow.

#### 6.3 Activation — the "aha" moment

Activation is the single most important thing to measure for a PLG SaaS. Define the **activation event** explicitly and instrument the path to it.

- **Proposed activation definition (org-level):** an org reaches activation when it has *both* (a) connected ≥1 data source **and** (b) completed ≥1 successful agent run that returned a result. Validate/adjust against retention correlation once data lands.

| Event | Trigger | Key props | Src |
|---|---|---|---|
| `agent.first_run_completed` ✦ | Org's first successful agent run | `duration_ms`, `tool_count` | server |
| `org.activated` ✦ | Activation criteria met (fired once per org) | `time_to_activate_hours`, `criteria` | server |
| `knowledge.first_result_viewed` ✦ | First time user sees agent output/value | — | client |

#### 6.4 Core engagement / feature adoption

Instrument every **primary feature surface** so we can see adoption breadth (how many features an org touches) and depth (how often).

| Event | Trigger | Key props | Src |
|---|---|---|---|
| `chat.message_sent` | User sends an agent message | `surface` (ask/chat), `char_count`, `attachment_count` | server |
| `agent.run_started` | Agent run begins | `trigger` (manual/automation), `model` | server |
| `agent.run_completed` | Run finishes successfully | `duration_ms`, `tool_count`, `token_total` | server |
| `agent.run_failed` | Run errors | `reason`, `error_code` | server |
| `agent.tool_invoked` | A tool is called (sampled if high-volume) | `tool_name` | server |
| `agent.response_rated` | User rates a response 👍/👎 | `rating`, `reason` | client |
| `agent.ui_component_rendered` | Generative-UI component shown | `component_id` | server |
| `connector.connect_started` | Connect flow opened | `connector_type` | client |
| `connector.connected` ✦ | Connector authorized | `connector_type` | server |
| `connector.sync_completed` | Data sync finishes | `connector_type`, `entity_count` | server |
| `connector.disconnected` | Connector removed | `connector_type` | server |
| `knowledge.search_performed` | KG/semantic search run | `result_count` | server |
| `automation.created` ✦ | Automation/playbook created | `trigger_type` | server |
| `automation.enabled` ✦ | Automation turned live (human-gated path) | `automation_id` | server |
| `automation.run_completed` | Automation executes | `status` | server |
| `workspace.created` | New workspace | `workspace_id` | server |
| `collaboration.member_invited` ✦ | Invite sent | `role`, `invite_count` | server |
| `collaboration.member_joined` | Invite accepted (org grows) | `role` | server |
| `content.asset_generated` | Image/doc/video generated | `asset_type` | server |
| `content.asset_downloaded` | Asset downloaded/exported | `asset_type` | client |
| `nav.feature_opened` | A major nav section opened | `feature` | client |
| `settings.updated` | A setting changed | `setting_key` | both |
| `search.command_palette_used` | Command palette action | `action` | client |

#### 6.5 Conversion & revenue (reconciled from Stripe)

| Event | Trigger | Key props | Src |
|---|---|---|---|
| `billing.plan_viewed` | Pricing/upgrade surface shown | `source` | client |
| `billing.checkout_started` ✦ | Checkout/upgrade initiated | `target_plan` | server |
| `billing.subscription_started` ✦ | First paid subscription | `plan`, `mrr`, `interval` | server (Stripe webhook) |
| `billing.subscription_upgraded` ✦ | Plan tier increased | `from_plan`, `to_plan`, `mrr_delta` | server |
| `billing.subscription_downgraded` | Plan tier decreased | `from_plan`, `to_plan` | server |
| `billing.subscription_canceled` ✦ | Subscription canceled (churn) | `plan`, `reason`, `tenure_days` | server |
| `billing.credits_purchased` ✦ | Credit pack bought | `amount_usd`, `credits`, `pack` | server |
| `billing.credits_low` | Balance crosses low threshold (\<$5) | `balance` | server |
| `billing.auto_reload_enabled` | Auto-reload turned on | `threshold`, `amount` | client |
| `billing.auto_reload_charged` | Auto-reload fires | `amount_usd`, `status` | server |
| `billing.payment_failed` | Card declined / payment error | `reason` | server |
| `billing.trial_started` / `billing.trial_ended` | Trial lifecycle (if used) | `plan`, `outcome` | server |

Use PostHog's **revenue / group properties** (`mrr`, `is_paying`, `plan` on the `organization` group) so revenue trends and paid-conversion funnels slice by account. Reconcile against Stripe; PostHog revenue numbers are directional, not the billing ledger.

#### 6.6 Friction & quality

| Event | Trigger | Key props | Src |
|---|---|---|---|
| `friction.form_error_shown` | Validation/submit error | `form`, `field`, `reason` | client |
| `friction.rage_click` | Rapid repeated clicks (autocapture) | `element` | client |
| `friction.dead_click` | Click with no effect | `element` | client |
| `friction.empty_state_viewed` | User lands on an empty/zero-data state | `surface` | client |
| `friction.search_no_results` | Search returns nothing | `query_kind` | both |
| `$exception` (client) / `error.server` | Unhandled error captured | `error_type`, `message`, `fingerprint` | both |
| `friction.upgrade_blocked` ✦ | Action blocked by plan/entitlement (`capability_not_installed`, quota) | `capability`, `required_plan` | server |

`friction.upgrade_blocked` is a high-value PLG signal — it tells you exactly which paywalled capability someone wanted. Feed it into upgrade funnels.

---

### 7. Standard properties (attached to every event)

Set as **super properties** (client, via `register`) and injected server-side by `@oxagen/analytics`:

- **Tenancy:** `org_id`, `org_slug`, `workspace_id`, `workspace_slug`, `plan`.
- **Identity:** `user_id`, `user_role`, `is_internal`.
- **Context:** `surface` (web/cli/mcp/api), `app_version` / `platform_version`, `environment`, `$event_source` (client/server).
- **Acquisition (person `$set_once`):** `initial_utm_source/medium/campaign/term/content`, `initial_referrer`, `signup_source`.
- **Session (client, automatic from PostHog):** `$current_url`, `$pathname`, `$browser`, `$os`, `$device_type`, `$referrer`, `$session_id`.

Rule: anything used to **slice every dashboard** (plan, tenancy, surface, internal flag) is a standard property, defined once, never re-derived per event.

---

### 8. Feature flags, experiments, surveys, replay

#### 8.1 Feature flags & experiments (A/B testing)

- Use PostHog **feature flags** for gradual rollouts, kill switches, and entitlement-adjacent gating (distinct from billing entitlements, which remain server-authoritative).
- Evaluate flags **server-side** for gating that affects security/billing; client-side for UI variants. **Bootstrap** client flags on first load to avoid flash and ensure first-event exposure is captured.
- Use **Experiments** for conversion-affecting changes (onboarding variants, pricing-page copy, paywall placement). Each experiment declares a primary metric (a key event from §6) and a guardrail metric. Capture **`$feature_flag_called`** exposure so experiment analysis is valid.
- Flag keys follow `domain_purpose` snake_case; document owner + cleanup date. Stale flags are tech debt — track removal.

#### 8.2 Session replay

- Enable replay for `apps/app`, sampled (e.g., 100% of sessions with errors/rage-clicks, lower % otherwise) to control cost.
- **Mask all input by default** (`maskAllInputs: true`), mask text where it may contain customer data, and **block** elements rendering PII or secrets (`.ph-no-capture` / block selectors). Never record passwords, tokens, billing card fields, API keys, or agent message content that may contain customer data. This is a compliance requirement, not a preference (§9).

#### 8.3 Surveys

- Use PostHog **surveys** for in-product **NPS** (relationship survey, quarterly), **PMF** ("how would you feel if you could no longer use Oxagen"), **CSAT** post-key-action, and **churn/cancellation reason** on downgrade/cancel. Target via cohorts/flags; cap frequency so users aren't spammed.

---

### 9. Privacy, consent & compliance (mandatory — SOC 2 / GDPR)

This is gating, not optional polish.

- **Consent gating.** Do not initialize analytics or replay until consent is resolved per the user's region/policy. Honor a cookie/consent banner; default to **opt-out** capture for replay/PII in regulated regions. Respect `Do Not Track` as configured.
- **PII minimization.** Do not send raw secrets, tokens, full agent message bodies, customer file contents, or card data to PostHog. Email is sent only if policy allows; otherwise use a hashed identifier. Maintain an explicit allowlist of person/group properties.
- **Server-side PII scrubbing** in `@oxagen/analytics` `before_send`: strip/deny-list known sensitive keys, truncate free-text, redact tokens by pattern — so a careless `capture` call can't leak.
- **Data residency.** US PostHog Cloud (`us.i.posthog.com`) — confirmed acceptable for our data-residency posture; document in the ADR.
- **Right to erasure.** Wire the **PostHog person-delete** into the GDPR erasure flow. `docs/gdpr/sop-data-erasure.md` currently lists PostHog erasure as *pending* — **closing that gap (a delete on account deletion, via PostHog API or the erasure webhook) is a release requirement of this spec.**
- **Data retention.** Configure project retention to policy; don't keep raw replay/events longer than needed. Document the retention window.
- **Internal traffic exclusion** (`is_internal`) and **bot filtering** enabled so metrics reflect real customers.
- **DPA / sub-processor.** Ensure PostHog is listed as a sub-processor in our DPA and on the public sub-processor list; the GDPR SOP references it — keep consistent.
- **Access control.** PostHog project access limited to staff who need it; SSO where available; no shared accounts. Personal API keys scoped and rotated.

---

### 10. Metrics, dashboards & alerts

#### 10.1 North Star & framework

- Pick **one North Star Metric** that captures delivered value — proposed: **Weekly Active Orgs running ≥1 successful agent run** (orgs getting value, not just logins). Confirm after data lands.
- Track the **AARRR funnel** end-to-end (Acquisition → Activation → Retention → Revenue → Referral) and a **HEART**-style quality view (Happiness via NPS/CSAT, Engagement, Adoption, Retention, Task success) for product quality.

#### 10.2 Required dashboards (built in PostHog)

1. **Acquisition & signup funnel** — sources → signup → verified → org created.
2. **Onboarding funnel** — the §6.2 funnel with step drop-off and time-to-convert.
3. **Activation** — % new orgs activated, median time-to-activate, activation by source/plan.
4. **Engagement** — DAU/WAU/MAU, **stickiness (DAU÷MAU)**, feature adoption breadth/depth, top/bottom features.
5. **Retention** — N-day and N-week **org-level** retention curves, cohorted by signup week and by plan.
6. **Revenue & conversion** — Free→paid conversion funnel, MRR trend, upgrade/downgrade/churn, credit purchase behavior, `friction.upgrade_blocked` → upgrade correlation.
7. **Friction & quality** — error rates, rage/dead clicks, form-error hotspots, no-result searches, response ratings.
8. **Feature-adoption matrix** — which plans/cohorts use which features (kills/justifies roadmap bets).

#### 10.3 Alerts

- Configure PostHog **insight alerts** on: signup-rate drop, activation-rate drop, payment-failure spike, error-rate spike, key-funnel conversion regression. Route to the team channel.

---

### 11. Implementation requirements (acceptance criteria)

A PostHog implementation is "done / on par" only when **all** of the following hold:

1. **`@oxagen/analytics` package exists** and is the only importer of `posthog-js`/`posthog-node`. Direct imports elsewhere fail lint.
2. **Typed event registry** enforces the §5 taxonomy at compile time; CI rejects unregistered events.
3. **Identity model wired:** `identify` on login, `reset` on logout, anonymous→identified stitching verified, **both groups attached automatically** server-side.
4. **Group analytics live** for `organization` + `workspace` with current group properties via `groupIdentify`.
5. **Server-side capture** for every ✦ key event (activation + revenue + signup), verified to fire without the client.
6. **Reverse proxy** in place; events arrive with ad blocker enabled.
7. **Separate prod/preview/dev projects**; CI/E2E capture disabled.
8. **Privacy controls:** consent gating, input masking on replay, `before_send` PII scrubbing, internal-traffic exclusion cohort, **GDPR person-delete wired** (closes the SOP gap).
9. **Stripe → PostHog** revenue events reconcile (subscription + credits) via webhook, with `mrr`/`is_paying`/`plan` on the org group.
10. **The 8 dashboards** built and the **North Star** + activation definitions agreed.
11. **Feature flags + at least one experiment** scaffolded with exposure capture.
12. **Verification evidence:** a live event lands in PostHog for one event from each domain (auth, onboarding, agent, connector, billing, friction), shown via the PostHog activity/live-events view; funnels populate; group filtering works. Per the engineering policy, no task is done without this proof.

---

### 12. Rollout plan

- **Phase 1 — Foundation:** `@oxagen/analytics` package, identity + groups, reverse proxy, consent gate, server-side key events (auth/onboarding/activation), onboarding + activation funnels. *Ship value fast; these answer the original "what do customers use / what converts" questions.*
- **Phase 2 — Breadth:** feature-adoption events, friction/error tracking, autocapture + pageviews, session replay (masked), engagement + retention dashboards.
- **Phase 3 — Revenue & experimentation:** Stripe revenue reconciliation, conversion dashboards + alerts, feature flags + first experiment, surveys (NPS/PMF/churn), GDPR person-delete wired and SOP updated.

Each phase gated by the §11 acceptance criteria relevant to it, verified with live PostHog evidence before close.

---

### 13. Open decisions (resolve before/early in Phase 1)

1. **Activation definition** — confirm the org-level "connected data **and** ≥1 successful run" criteria against retention once data exists.
2. **North Star** — confirm "Weekly Active Orgs with ≥1 successful run."
3. **`distinct_id` choice** — user UUID vs `public_id` (pick one, immutable forever).
4. **Email in PostHog** — send plaintext (with consent) vs hashed only.
5. **Replay sampling rate** and which surfaces.
6. **Retention window** for events/replay per compliance.
7. **Self-hosted / air-gapped customers** — global analytics kill switch behavior.

