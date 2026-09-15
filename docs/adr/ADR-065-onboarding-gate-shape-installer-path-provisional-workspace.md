# ADR-065: Onboarding: gate shape, installer path, provisional workspace

- **Status:** Accepted
- **Date:** 2026-09-15
- **Owners:** platform
- **Related:** #2967 (the lane this records), `apps/app/ARCHITECTURE.md`
  §1.2 (the routes deleted at WL-07 and the gap lanes), the Mission Control
  spec `2026-09-11-oxagen-mission-control-spec.md` (§3 "Onboarding is gated,
  and it is three steps", §6.2, §7.2, §14.1, App. E `register_agent`,
  `enroll_host`, App. F), the Mockups repo `pages/onboarding-*.md` and
  `pages/register-*.md` (the per-page design of record), `mc.html`
  `OB_STEPS`, `obUnlock`, `REG_TOKEN`, ADR-057 (agents: the identity half in
  Postgres, `register_agent` and the long-lived agent credential),
  `docs/specs/tacho/spec.md` §5 (enrollment; §5.6 is this decision's token),
  `packages/database/src/schema/org.ts` (`onboarding_state`),
  `packages/database/src/schema/tacho.ts` (`enrollment_tokens`)

## Context

The mockup's onboarding is a rail of five steps — sign up, verify email,
name the organization, wrap an agent, start a run — and "the first frame is
what opens Mission Control": an organization does not see the app until an
agent it wrapped has talked to Oxagen. Nothing in the tree recorded where an
organization stood in that sequence, the register flow's screens rendered
from fixture data, and WL-07 deleted `/welcome/[[...step]]` and
`/{org}/{ws}/register/[[...step]]` outright, so a new organization landed on
Fleet's empty state with the `oxagen agent enroll` instruction. #2967 keeps
the gate (maintainer, 2026-09-14) and records three decisions it left open.

Three things had to be decided before the backend could be built: the shape
the gate returns in, whether the installer is a signed package with the
one-time token embedded or the CLI path, and whether the provisional
workspace and the seven-day conversion offer ship together.

## Decisions

### 1. The gate is state on the organization and a rail over real pages

Rev1 landed on Fleet's empty state (WL-07), and the gate returns as a rail
over the pages that exist rather than as separate screens:
`/{org}/{ws}/register/{step}` over `register_agent` for the register flow,
and `/welcome/*` collapses into the sign-in flows plus the rail. The backend
half is one row per organization, `org.onboarding_state`:

- `step` is `wrap`, `run` or `unlocked`. The row exists from the moment
  `create_org` returns — the mockup's `organization` step is complete when
  the organization is — and `get_onboarding_state` answers `organization`
  for a caller with no organization. Sign-up and email verification belong
  to the session and are not recorded here.
- `advance_onboarding` moves between `wrap` and `run` and refuses
  `unlocked` (`conflict: first_frame_required`). `unlocked`, `first_frame_at`
  and `first_run_id` have exactly one writer: `ingest_tacho_events`, on the
  first root session it accepts from one of the organization's hosts,
  guarded on `step <> 'unlocked'` so the first batch to land wins. The run
  step never completes on a timer.
- The agent whose first frame opened the gate is stamped
  `agent.agents.registered_via = 'onboarding'` at that moment (mockup
  `obUnlock`: the agent exists on the first frame). `ui` is the column
  default. `cli` is admitted by the CHECK for `register_agent` (ADR-057,
  #3014, open at the time of writing) to write when its context's surface is
  the CLI; until that line lands, the default and the ingest are the
  column's only writers.
- Organizations that predate the gate get no row. They were never
  provisional and no first frame is known for them; a backfilled `unlocked`
  row would carry a window that had already elapsed and would make
  `publish_context_record` refuse every existing workspace until it bound a
  repository. A missing row reads as `unlocked` with `provisional: null`,
  has no gate to move (`advance_onboarding`: `not_found: gate_not_found`),
  and passes the provisional check. The table's CHECK holds a row
  `unlocked` exactly when it carries `first_frame_at` and `first_run_id`.

`get_first_frame` is the page's wait: for one registered agent, the host
enrolled for it, what that host last reported, and the first session from
it, long-polled with the `waitMs` budget `get_run` takes.

### 2. The CLI path first, with a one-time token printed once

The installer is the CLI: `oxagen agent enroll --token <token>` over
`enroll_host`. The signed package with the token embedded (mockup 7349) is
a later lane with its own build and signing rig.

`create_enrollment_token` (org Owner or Admin, the gate
`create_tacho_enrollment` keeps) mints the token for one registered agent —
`oxe_1time_` and 26 Crockford characters, shown once, stored as its SHA-256
digest in `tacho.enrollment_tokens`, thirty minutes by default and sixty at
most. `enroll_host` is unscoped and public: the token is the credential, and
the handler resolves the tenant from it, locks the row, mints exactly what
`create_tacho_enrollment` mints (the shared `lib/tacho-host-enroll.ts` is
the one writer of a host row and its `tacho_host_v1` key) with the host
bound to the token's agent and principal, and marks the token used by that
host in the same transaction. A second presentation is `conflict:
token_used`; an expired one `conflict: token_expired`; both are counted on
the row for the installer's "token rejected" screen. The host reports the
git remote it ran in, which the gate records as `detected_repository` for
the "Repository detected" offer.

`register_agent` (ADR-057, #3014) mints the identity and the long-lived
agent credential; the enrollment token is issued separately, on the
registered agent, because a token that expires unused must be replaceable
without re-registering the agent, and because the two secrets have
different lives (a credential the operator keeps; a token a machine
consumes once).

### 3. The provisional workspace ships; the offer waits

An organization is provisional from creation: `provisional_until` is
fourteen days out (spec §3), and `main_repo_bound_at` is null until
`bind_main_repository` runs. The predicate is the null, and the date is the
window the banner prints. While provisional, `publish_context_record`
refuses with `conflict: provisional`: a steering record has nowhere to
publish to. `commit_agent_definition` (ADR-057) already refuses a workspace
with no binding.

`bind_main_repository` names only the repository. The GitHub App
installation comes from the workspace's GitHub connection, attached by the
API's HMAC-verified callback, never from the caller: an installation id a
caller could choose would let one tenant mint tokens for another account's
installation. The handler reads the repository through the installation's
token, writes the version-1 `ingestion.repository_bindings` row and its
head (the rows the run ledger pins and `commit_agent_definition` commits
to), marks the connection connected (the row `resolveGitHubToken` mints
from), and closes the window.

The seven-day conversion offer (`obOfferCard`) waits on the pricing
decision ADR-055's contracted-rate model leaves to the maintainer; the
`offer_shown_at` / `offer_converted_at` columns the issue lists are not in
the table, because nothing would write them.

## Consequences

- `get_onboarding_state`, `advance_onboarding`, `get_first_frame`,
  `bind_main_repository`, `create_enrollment_token` and `enroll_host` are
  live contracts with handlers, API routes and docs. The two reads have MCP
  tools. The two operator writes (`advance_onboarding`,
  `bind_main_repository`) and the two credential paths have none: the MCP
  context carries an API key and no user (`apps/mcp/src/context.ts`), and
  the writes' role check (`assertOrgRole`) refuses a context without a
  user, so a tool for them could never succeed.
- `create_org` opens the gate; `ingest_tacho_events` closes it and binds the
  session to the host's agent (`tacho.sessions.agent_id`,
  `agent_principal_id`).
- `get_install_instructions` answers the wrap steps for `claude-code` and
  `codex` when handed an enrollment token; the SDK tab waits on the
  `@oxagen/tacho/claude-agent-sdk` adapter the tacho spec §8 describes,
  which does not exist in the tree.
- `oxagen agent enroll --token` is the scripted path; `oxagen tacho enroll`
  keeps the operator path. The tacho CLI's `enroll` routine carries both.
- The app lane builds the rail, the register stepper, the first-frame wait
  over the SSE transport, the first-run Fleet banners and the `Bind <repo>`
  action on these contracts.
