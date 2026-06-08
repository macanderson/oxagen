# Oxagen: Hardening · AI Cost · Editable Prompts · Motion/Mobile · Rebrand

**Date:** 2026-06-08
**Status:** Approved (design) — executing
**Author:** Claude (Opus 4.8) under direction of Mac Anderson

## Summary

A five-program campaign. Programs 1–4 land directly on `main` (pre-launch build
mode). Program 5 (corporate rebrand) lands as a single new PR, executed last so
it re-skins the finished, hardened, motion-rich, mobile-first app rather than a
moving target.

Decisions locked with the user:
- **Rebrand scope:** platform-wide via the shared `@oxagen/ui` token source
  (app + website + admin inherit); full rich treatment built in `apps/app`.
- **Prompt control:** tiered — `additionalInstructions` for everyone (appended to
  every agent), full overrides of a **curated safe set** for enterprise, core
  chat-orchestration prompt **append-only** to protect tool-call + inline-UI
  contracts.
- **Hardening intensity:** targeted high-ROI on real hotspots, not exhaustive
  line-by-line (codebase is already healthy: ~9 `any`, 1 TODO, strong CI).

## Codebase facts established (pre-work mapping)

- **AI chokepoints** (all metered/billed): `streamAgentReply`, `generateObjectFor`,
  `generateImageFor`, `generateVideoFor` in `packages/ai/src/`.
- **Prompts are all inline string literals** — no registry, no DB storage, no
  override layer. Locations: `packages/agent/src/system-prompt.ts`
  (`buildChatSystemPrompt`), `apps/app/src/app/api/v1/chat/stream/route.ts`
  (auto-titler), `packages/inngest-functions/src/functions/agent.workflow.supervisor.ts`,
  `.../agent.workflow.task.execute.ts`, `packages/handlers/src/form.fill.ts`,
  `.../svg.generate.ts`, `.../image.generate.ts`.
- **No prompt caching active** — `cached_tokens` hardcoded `0` in all four
  chokepoints; no `cacheControl` markers anywhere.
- **Workspace settings:** `packages/database/src/schema/workspace.ts` —
  `workspace.workspaces.settings` JSONB column is **unused** and available;
  model settings use dedicated columns + the `workspace.model.settings.*`
  contract→API→MCP→UI pattern (the template to clone).
- **Documents (DOCX/XLSX/PPTX) are built in-process, no LLM** — prompt
  enhancement applies to image/SVG/video/chat-content generation only.
- **Frontend:** shell at `apps/app/src/components/shell/*` (floating sidebar +
  `MobileBottomBar` + `MobileNav` sheet, safe-area aware); motion tokens in
  `packages/ui/src/lib/motion.ts` + `tokens.css`, `MotionProvider` wires
  `reducedMotion`. Brand is **currently neutralized on purpose** in
  `packages/ui/src/styles/tokens.css` (documented restore point); logo is inline
  SVG in `packages/ui/src/components/brand.tsx` + `apps/app/src/app/icon.svg`;
  fonts are self-hosted Aeonik.

## Program 1 — Targeted hardening (→ main)

Decompose 5 hotspots, behavior identical, verified by tests:
- `chat/stream/route.ts` (980) → extract prompt assembly, `streamMediaGeneration`,
  auto-titler, SSE encoding, model resolution into co-located modules.
- `use-tool-stream.ts` (612) + `chat-shell-client.tsx` (697) → extract reducer +
  per-event handlers.
- `billing/subscriptions.ts` (706), `org-plugins-panel.tsx` (987) → split by concern.
- `kernel.ts` (687) → surgically extract IAM-check / billing-admission /
  security-event helpers. `config/registry.ts` (988) is declarative data — split
  only if it genuinely helps.

Plus: fix 3 empty `catch {}`, replace ~5 non-CLI `console.log` with structured
telemetry logging, harden error handling + debug logging on hot paths, convert
independent sequential awaits to `Promise.all`, delete dead code, fix every bug
found en route.

## Program 2 — AI cost + prompt architecture (→ main)

- **Prompt caching:** add provider `cacheControl` to stable system-prompt
  prefixes in `streamAgentReply` + `generateObjectFor`; wire real `cachedTokens`
  from provider response into telemetry (replace hardcoded `0`).
- **Prompt registry:** move every inline prompt into a typed, versioned baseline
  module with one `resolvePrompt(key, ctx)` merging baseline + workspace overrides
  + appended instructions. Optimize each prompt (tighter, cache-friendly stable
  prefix).
- **Parallelism/batching** only where genuinely independent.

## Program 3 — Editable prompts + Auto-improve (→ main)

- Tiered model in `workspace.workspaces.settings`: `additionalInstructions`
  (all tiers), `promptOverrides` (enterprise-gated, curated safe keys only — core
  orchestration prompt append-only), `autoImprovePrompts` (**default ON**, Beta).
- **Auto-improve judge:** fast-tier LLM judge in the content/media generation
  path; judges sufficiency, enhances if insufficient, instrumented, gated by the
  toggle. Help text: "A model judges whether your prompt is sufficient; if not, it
  will attempt to enhance context, which may yield unintended results." + Beta badge.
- Full parity: contract → API route → MCP tool → settings UI; explicit
  enterprise/role assert at call site (app doesn't bootstrap IAM); `check:manifest`
  clean; tests + docs + Linear ticket.

## Program 4 — Motion + mobile-first (→ main)

- Mobile thumb-first: composer/ask on mobile, ≥44px touch targets, primary actions
  in thumb reach; verified in a real browser at 390px.
- Tasteful motion beyond chat: sidebar collapse, route transitions, nav, list
  staggers, press feedback — on existing motion tokens, honoring `reducedMotion`.

## Program 5 — Corporate rebrand (→ new PR, last)

- New identity in shared `@oxagen/ui` tokens (app/website/admin inherit):
  blue/purple primary + yellow/black/orange accents, dark-mode-first, new gradient;
  new logomark + wordmark; distinctive type; in-app tours + help text.
- 2–3 concrete visual concepts presented to the user before execution.

## Verification

typecheck + tests green pre-push; browser-verified UI (desktop + 390px mobile);
`check:manifest` + `check:contracts` clean for new capabilities; Linear tickets
filed per convention.
