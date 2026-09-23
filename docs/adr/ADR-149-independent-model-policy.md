# ADR-149: Independent model policy

Status: Accepted for implementation under the maintainer's 2026-09-22 instruction to ship MUST-HAVE items 01 through 12 autonomously.

## Decision

A workspace Owner or Admin explicitly enables its model allow and deny lists through `update_tacho_session_policy`. The workspace policy's `mode` arms only the model clause. The agent's published budget arms only its per-run budget. Neither setting changes the other.

Choose option 2 from #3727. Presence of `models` in a signed bundle means the workspace enabled its lists. Absence means the host received no armed model clause. No second mode field is needed inside that clause. Deny takes precedence over allow. A null allowlist permits models except those denied. An empty allowlist permits none.

A new `models_independent` advertised feature distinguishes the new semantics from older hosts that parsed `models` but checked it only with an enforced budget. The server sends no model clause to those older hosts. The UI reports supported host counts and says upgrades and a mandate refresh are required. A saved policy is not evidence that a host has fetched it.

The server reads the workspace policy within the existing scoped bundle transaction. The content digest changes when enabled lists change or are disabled. The proxy checks lists before forwarding, including uncorrelated requests. A metered endpoint with an unreadable or ambiguous model is refused while lists are enabled. Read-only vendor endpoints that do not name a model retain their existing behavior.

The legacy workspace `sessionLimitUsd` remains recorded for compatibility and does not enforce a budget. The write rejects enforced mode with no model clause, even if that legacy ceiling is populated. Per-day enforcement remains a separate task in #3728. Cursor model traffic remains unrouted. Stella's Anthropic route is covered, not its other providers.

## Verification

Bundle tests cover explicit workspace modes, independence from budget mode, and omission for legacy hosts. Proxy tests exercise refusal before the fake upstream receives traffic, including observed budgets, uncorrelated calls, and unreadable model bodies. Handler tests preserve role checks and reject a legacy ceiling without model lists. Form and component tests cover the explicit switch and host reach report. CI supplies execution evidence.
