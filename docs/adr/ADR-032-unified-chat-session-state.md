# ADR-032 — Unified chat session state (chat_ux_v2)

Date: 2026-07-14 · Status: Accepted · Scope: `apps/app` chat surface

## Context

The chat surface accumulated four uncoordinated holders of run-context state:

1. `ChatSelectionProvider` (agent + repo + env, localStorage `oxagen:chat-agent:*`),
2. the optional pin store (repo + env again, localStorage `oxagen:chat-pins:*`),
3. `ComposerModelState` (model/tier/effort/budget, component state, not persisted per conversation),
4. the durable server `code_binding` (agent + repo + env, Postgres, claimed on the first code turn).

Branch had **no owned state at all** — every surface derived it independently
(PR head ref ?? binding default branch ?? selected repo default branch), which
is how the read-only Context panel could show `main` while the composer showed
`development` for the same conversation. Settings were also scattered across
five UI surfaces (composer selects, overflow sheet, agent picker dropdowns,
pin row, Context panel), so most settings had two or more visible controls.

## Decision

One state object, one write path, per-conversation persistence:

- **`ChatSessionState`** (`apps/app/src/components/chat/session/session-state.ts`):
  `{ agentId, tier, model, effort, budgetUsd, org, repoKey, branch, envId,
  outputs: { image, video } }`. Branch is a first-class, explicitly owned field
  (null = the repo's default branch).
- **`applySessionPatch` is the only reducer.** It owns the cascade rules
  (org change resets repo+branch; repo change resets branch and re-derives
  org; explicit model ⟷ tier exclusivity), so no call site can skip them.
- **`ChatSessionProvider`** (`session-store.tsx`) owns persistence: committing
  writes (never key-scoped effects), per-conversation localStorage keys with
  draft→conversation migration on first send, and per-agent-per-workspace
  memory of the last code context (`org/repo/branch/env`).
- **The durable `code_binding` stays authoritative** for agent + repo + env on
  code conversations; the store force-syncs onto it (`applyCodeBinding`) so a
  stale persisted selection can never shadow it. Branch remains editable on a
  bound conversation (the binding pins the repo, not a feature branch).
- **Locks**: agent is locked after the conversation's first message
  (generalizing the previous first-code-turn lock); org/repo/env lock when a
  binding exists. Locked fields are rejected by the write path, not just
  visually disabled.
- Every display — the conversation-header subtitle (the only permitted
  read-only echo), the SessionSettings surface (drawer / slide-over / rail),
  and the run payload — is a projection of this one store value.

All of this ships behind the `chat_ux_v2` flag (`NEXT_PUBLIC_CHAT_UX_V2` env
default + `chat_ux_v2` cookie override via `?chat_ux_v2=1|0`, resolved once
server-side in `lib/flags.ts`), default off, until all seven overhaul PRs land.

## Consequences

- The `main`-vs-`development` mismatch class is structurally impossible: there
  is no second store to disagree with, and the binding wins deterministically.
- Legacy stores (`chat-selection-context`, `pinned-context`,
  `ComposerModelState` seeding) remain in place for the flag-off path and are
  deleted when the flag is removed; while both exist, bridge adapters present
  the legacy interfaces backed by the unified store so the flag-on run payload
  reads the same values the UI shows.
- New capability `list_branches` (`repo` domain) backs the explicit Branch
  picker (contract → handler → API → MCP per capability parity).
- Per-conversation settings persistence is localStorage-first (same as the
  stores it replaces); server-side persistence beyond the existing
  `code_binding` is intentionally out of scope for the overhaul.
