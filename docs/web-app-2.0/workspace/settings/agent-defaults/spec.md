---
# Workspace Settings — Agent Defaults

- **Route:** `/{orgSlug}/{workspaceSlug}/settings/agent-defaults`
- **Nav location:** workspace → Settings → tab "Agent Defaults" (sub-tabs: Models · Budget · Prompts · Memory Policy)
- **Priority:** P2
- **Disposition vs today:** Merge (consolidates `settings/models` + `settings/budget` + `settings/prompts` + `settings/memory` into one page with sub-tabs)

## Purpose
One page for every workspace default that shapes agent behavior and spend: which models agents reach for, per-turn spend caps, governing system-prompt instructions, and memory decay tuning. Today these are four separate top-level tabs; grouping them cuts the settings tab count without losing control.

## Primary user & jobs-to-be-done
- **Primary user:** Workspace Owner/Admin
- **JTBD:**
  - Set default text/image/video models so runs start from vendor-neutral defaults.
  - Cap per-turn spend (hard stop / grace / prompt-to-continue) so agent loops can't blow past commercial terms.
  - Review the composed system prompt and add per-capability overrides.
  - Tune memory half-lives and decay thresholds so agent memory stays current without manual pruning.

## Functionality
- **Models:** `Default text tier` (select), `Default text model`, `Default image model`, `Default video model`. Owner/Admin-gated save.
- **Budget:** `Enabled` (switch), `Limit (USD)`, `Mode` (grace/prompt/enforce), `Grace cushion %` (grace only), `Enforcement` (hard ceiling vs seed-only default). Owner/Admin-gated.
- **Prompts:** read-only composed `chat.system` viewer + editable per-capability overrides; "Additional instructions" is Enterprise-gated.
- **Memory Policy:** `Observation half-life (days)`, `Rule half-life (days)`, `Recall confidence threshold` (0–1), `Compliance threshold` (1–100), `Default decay floor` (0–100). Facts never decay.
- Independent save + toast per sub-tab; no cross-tab save.

## Capabilities invoked
- `workspace.model_settings.read/write` (`get_model_settings`/`update_model_settings`) — Models.
- `workspace.budget_policy.read/write` (`get_budget_policy`/`update_budget_policy`) — Budget (workspace-governed).
- `budget.policy.read/write` (`get_user_budget`/`update_user_budget`) — user-scoped per-turn preference members inherit from; referenced, no separate form.
- `prompt.settings.read/write` (`get_prompt_settings`/`update_prompt_settings`) — Prompts.
- `agent.memory_policy.read/write` (`get_memory_policy`/`update_memory_policy`) — Memory Policy.
- `user.workspace_preferences.read/write` (`get_workspace_user_preferences`/`update_workspace_user_preferences`) — per-user coding-agent defaults (repo/environment). **Contract gap:** both declare `app` in `layers[]` yet neither is invoked in `apps/app` today (only a Storybook reference) — close this gap.

## Data sources
Postgres only, via the contracts above. No Neo4j/ClickHouse/blob — configuration rows, not runtime events.

## States
- **Empty:** never — every sub-tab reads a row seeded with defaults at workspace creation.
- **Loading:** server-rendered per sub-tab; lightweight skeleton on client-side sub-tab switch.
- **Error:** inline alert text on save failure, never a raw throw.

## Existing implementation
- **Today:** all four source pages complete, tested, standalone. Reuse the four forms verbatim as sub-tab bodies; build only the tab shell and the still-unwired workspace-preferences UI.

## Vision alignment
Budget policy is the metering→billing wedge at the per-turn level; model defaults via `modelIdOf()` are the BYOK moat in practice; prompts/memory close the loop toward the accountability chain.
