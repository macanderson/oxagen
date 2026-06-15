---
name: oxagen-design
description: Use this skill to generate well-branded interfaces and assets for Oxagen, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping. Oxagen gives AI agents secure, RBAC-scoped context from a typed Neo4j knowledge graph — jewel-tone, high-contrast, developer-focused, dark-first.
user-invocable: true
---

Read the `readme.md` file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy
assets out and create static HTML files for the user to view. If working on
production code, you can copy assets and read the rules here to become an expert
in designing with this brand.

Quick start:
- **Tokens & fonts** — link `styles.css` (it `@import`s everything: jewel-tone
  color ramps, Aeonik fonts, type/spacing/motion, base + brand utilities).
  `:root` is the dark "deep space" theme; add `class="light"` for the light theme.
- **Brand** — Cyan `#7CE8F4` · Violet `#7C5AED` (primary) · Cosmos `#DF2A5D`,
  over deep-indigo→cyan. Signature gradients: nebula / aurora / cosmos / sunset.
  Type: Aeonik Fono (display), Aeonik (UI/body), Aeonik Mono (code/eyebrows/IDs).
  Icons: **Lucide**, thin stroke, currentColor. No emoji. Sentence case.
- **Components** — load the compiled `_ds_bundle.js`, then
  `const { Button, Card, Badge, NodeChip, ConfidenceBar, OxagenLogo } = window.OxagenDesignSystem_2dfe15`.
  See `components/*/*.prompt.md` for usage and `components/*/*.card.html` for live demos.
- **Full product look** — see `ui_kits/app/index.html` (Login → Ask chat,
  Knowledge graph, Access/RBAC). Reuse its `Shell.jsx` + `icons.jsx` patterns.

If the user invokes this skill without any other guidance, ask them what they
want to build or design, ask some questions, and act as an expert designer who
outputs HTML artifacts *or* production code, depending on the need.

---

## GenAI conversation components (v2)

For AI agent conversation surfaces, the Ask screen, and chat panels. All components follow the brand tokens in `styles.css` (jewel-tone dark-first, Aeonik type, Lucide icons, no emoji, sentence case).

The full assistant UI kit is at `ui_kits/assistant/index.html` — a complete 3-panel layout: left conversation list, center chat thread + composer, right usage/files panel.

In production code these map to components in `apps/app/src/components/chat/` — the existing components there implement similar patterns adapted for Next.js/TypeScript, referencing these design specs for visual treatment.

### ConversationList
Left-rail conversation list.

Props: `items[]` (`{id, title, snippet?, time?, cost?, pinned?, unread?}`), `active`, `onSelect`, `onNew`, `searchable`.

Renders pinned/recent groups, search input, and cost badges per item.

### ConversationView
Scrollable message thread.

Props: `messages[]` (MessageBubble props + `id`/`text`/`role`), `thinking`, `thinkingLabel`, `maxWidth`.

Auto-scrolls to newest message; renders ThinkingIndicator when `thinking` is true.

### MessageBubble
One conversation turn.

Props: `role` (`user` | `assistant` | `system`), `children`, `model`, `time`, `attachments[]`, `reasoning` (ReasoningTrace props), `actions`.

User messages are right-aligned with accent background; assistant messages are left-aligned with sparkle avatar.

### PromptComposer
Full enterprise prompt-submission control: autosizing textarea, attachment tray (drag-drop), ModelSelector, EffortSelector, BudgetControl, Send/Stop buttons.

Props: `placeholder`, `onSubmit({text, attachments, model, effort, budget})`, `busy`, `onStop`, `models`, `defaultEffort`, `defaultBudget`, `projectedCost`, `footnote`.

### ThinkingIndicator
Animated working affordance shown while the agent is reasoning.

`variant`: `"dots"` | `"bubble"` | `"shimmer"`. Props: `label`.

### ReasoningTrace
Chain-of-thought timeline, collapsible behind a "Thought for Ns" summary pill.

Props: `steps[]` (`{type: "thought" | "tool" | "decision", text?, ...ToolCallCard props}`), `summary`, `durationMs`, `defaultOpen`, `streaming`.

### ToolCallCard
One tool invocation, collapsible with args/result body.

Props: `name`, `icon`, `risk` (`low` | `medium` | `high`), `status` (`running` | `success` | `error`), `latency`, `args`, `result`, `defaultOpen`.

### TokenUsageBar
Context-window meter segmented into input / cached / output.

Props: `input`, `cached`, `output`, `window`, `showLegend`.

Shows amber warning at 75% fill and red warning at 90% fill.

### SessionSummary
End-of-session stats panel: cost, tokens, turns, latency stats + TokenUsageBar + per-model breakdown.

Props: `usage` (`{cost, costCap?, tokensIn, tokensCached, tokensOut, window, messages, latencyMs, breakdown[]}`).

### ConversationFiles
Files panel showing uploaded and produced files.

Props: `files[]` (`{id, name, size?, type?, source?, status?}`), `onOpen`, `onRemove`, `title`.

### AttachmentChip
Compact file pill with typed glyph, name, size, indexing status, and remove button.

Props: `name`, `type`, `size`, `status` (`ready` | `indexing` | `error`), `progress`, `onRemove`.

### FileUploader
Drag-and-drop dropzone with AttachmentChip list.

Props: `files`, `onChange`, `accept`, `hint`.

### ModelSelector
Model dropdown with provider label, context-window size, and pricing.

Props: `models[]`, `value`, `onChange`.

### EffortSelector
Reasoning-effort segmented control with three levels.

Props: `value` (`instant` | `balanced` | `extended`), `onChange`.

### BudgetControl
Per-request spend cap control with preset buttons and a projected-cost meter.

Props: `value`, `onChange`, `projected`.
