---
title: "Command Menu"
description: "Archived spec & plan — status: shipped (audited 2026-07-03)."
---

> **Status: Shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The Command Menu spec is fully shipped and operational. All core deliverables are present: the CommandMenu React component with full keyboard navigation, 10 built-in prompt templates in a working registry, both command.menu.suggest and command.menu.search capability handlers, API routes for suggestions and entity search, hooks for page entity registration and suggestions, and supporting UI components. The feature integrates with the Ask Bar/Ask Drawer surfaces and provides context-aware prompts via LLM, entity search, quick actions, navigation, and recent queries—all gated by user capabilities.

**Implementation evidence**

- packages/prompt-templates/src/index.ts — registry + getApplicableTemplates function
- packages/prompt-templates/src/render.ts — template rendering with variable substitution
- packages/prompt-templates/src/templates/ — 10 built-in YAML templates shipped (connect-data-source, create-trigger-for-event, explain-audit-event, invite-teammate, open-source-playbook, run-this-playbook, show-similar-failed-runs, summarize-run-failure, summarize-workspace-activity, why-is-trigger-failing)
- packages/oxagen/src/contracts/command.menu.suggest.ts — suggest capability contract with SuggestionContext schema
- packages/oxagen/src/contracts/command.menu.search.ts — search capability contract with SearchResultRow schema
- packages/handlers/src/command.menu.suggest.ts — suggest handler with LLM call logic and org opt-out gate
- packages/handlers/src/command.menu.search.ts — search handler composing ontology + Postgres results
- apps/api/src/routes/v1/command.menu.suggest.ts — Hono route for suggest capability
- apps/api/src/routes/v1/command.menu.search.ts — Hono route for search capability
- apps/app/src/app/api/command-menu/suggestions/route.ts — POST handler with caching
- apps/app/src/app/api/command-menu/search/route.ts — POST handler with capability invoke
- apps/app/src/components/shell/ask/command-menu.tsx — CommandMenu React component with sections: suggestions, quick actions, navigate, search, recent
- apps/app/src/lib/command-menu/use-recent.ts — localStorage-backed recent queries hook
- apps/app/src/lib/command-menu/use-suggestions.ts — LLM suggestions hook with fetch
- apps/app/src/lib/command-menu/intent-router.ts — intent classification logic
- apps/app/src/lib/command-menu/entity-prefix.ts — entity prefix pattern matching (run #, @, playbook, trigger, event, agent)
- apps/app/src/lib/page-context/index.tsx — usePageContext + useRegisterPageEntity hooks for entity registration
- packages/ui/src/components/combobox.tsx — WAI-ARIA combobox UI primitives
- git commits: f31aaa35 (prompt-template registry), 00d53005 (entity search + LLM suggestions), 306c1ae9 (API route wiring), 628839fb (static template bundling)

**Source documents** (archived verbatim below)

- `docs/specs/command-menu/spec.md`

## Spec — `spec.md`

## Command Menu — Specification

Requirements spec for the `⌘K` (Cmd+K / Ctrl+K) command menu in `apps/app`. Builds on [`../information-architecture/spec.md`](../information-architecture/spec.md) and [`../application-shell/spec.md`](../application-shell/spec.md).

Status: **proposed**, locked by product.

---

### 1. Problem

The IA exposes ~40 destinations across three navigation modes. The Application Shell spec proposes static nav for daily-use surfaces and Ask-driven traversal for the long tail. The Command Menu is the bridge between those two: a single surface a user can summon from anywhere that lets them **navigate**, **perform common tasks**, or **launch the agent** with intent-aware suggestions tuned to the page they're on.

Goals:

1. **One keystroke from anywhere.** `⌘K` opens the menu over any page. No exceptions.
2. **Context-aware out of the gate.** When the menu opens, the top suggestions reflect what the user is *currently looking at* — the page, the entity in URL params, recent actions.
3. **Agent-first.** Most "common tasks" prepopulate a prompt template into the interactive agent and submit, not invoke a hand-built UI form per action.
4. **Capability-gated.** Items the user can't invoke are not shown — they don't appear and ghost, they're just absent.

---

### 2. Relationship to the Ask Bar and Ask Drawer

These three surfaces share one underlying engine but present differently:

| Surface | Where | When | Visual |
|---|---|---|---|
| **Ask Bar** | Topbar (slot 4) | Always visible | Inline input, single line, ~360px wide |
| **Command Menu** | Floating overlay, centered | `⌘K` from anywhere, OR clicking the Ask Bar to expand | Modal-ish dialog, ~640px wide, with categorized sections |
| **Ask Drawer** | Right-side slide-in | Opens when an intent resolves to "Ask" | 480px wide, full-height; the chat surface |

The Ask Bar and Command Menu **share the same state, suggestions, and intent router**. The difference is presentation:

- Typing in the Ask Bar shows a small inline dropdown of top suggestions (5 max).
- `⌘K` or clicking the Ask Bar's expand affordance opens the full Command Menu overlay with categorized sections.
- Either surface, when the user picks an "Ask" item, hands off to the Ask Drawer.

The user never has to choose between them — they choose the modality (inline typing vs. full overlay) that fits the moment.

---

### 3. Open / close behavior

| Trigger | Behavior |
|---|---|
| `⌘K` (Mac) / `Ctrl+K` (Win/Linux) | Open the Command Menu overlay, focus the input, blur the page behind. |
| `/` (slash) | Focus the Ask Bar (inline, no overlay). Same convention as GitHub, Linear, Vercel. |
| Click Ask Bar's expand button or empty area | Open the Command Menu overlay seeded with the Ask Bar's current input. |
| `Esc` | If overlay is open → close. If Ask Bar is focused → blur. If neither → no-op (do not interfere with page-level Esc handlers). |
| Click outside | Close the overlay. Preserve the typed input across reopen for the rest of the session. |
| Route change | Close the overlay. Cached suggestions for the new page begin loading. |

Open animation: 120ms scale-fade (`scale(0.98) → scale(1)`, `opacity(0) → opacity(1)`). Respect `prefers-reduced-motion`.

---

### 4. Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Ask anything or jump to…                            ⏎      │  ← input
├─────────────────────────────────────────────────────────────┤
│  SUGGESTED FOR THIS PAGE                                    │
│    ▸ Summarize this run's failure                           │
│    ▸ Show me other runs that hit the same error             │
│    ▸ Open the source playbook in editor                     │
│                                                             │
│  QUICK ACTIONS                                              │
│    ▸ Create trigger for this event           ⌘ E            │
│    ▸ Invite a teammate                                      │
│    ▸ Connect a data source                                  │
│                                                             │
│  NAVIGATE                                                   │
│    ▸ Access › Grants                                        │
│    ▸ Activity › Approvals (3)                               │
│    ▸ Workspaces › Production                                │
│                                                             │
│  RECENT                                                     │
│    ▸ Run #4221  ·  2 mins ago                               │
│    ▸ Playbook  churn-investigate v3  ·  8 mins ago          │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  ↑↓ navigate    ⏎ select    ⇧⏎ in new tab    ⌘K close       │  ← footer hints
└─────────────────────────────────────────────────────────────┘
```

#### Sections, top to bottom

1. **Input field** — placeholder rotates: `"Ask anything or jump to…"`, `"Try: 'why did this fail?'"`, `"Try: 'invite teammate'"`.
2. **Suggested for this page** — LLM-generated, context-aware. Up to 4 items. Section hides when no suggestions are loaded yet (skeleton for ≤500ms, then either reveal or hide).
3. **Quick actions** — Template-driven actions matching the user's current context and grants. Up to 6.
4. **Navigate** — Sidebar destinations + their tabs, filtered by user grants. Fuzzy match on input.
5. **Search results** — Replaces Quick Actions + Navigate when the input matches entity prefixes (`run #`, `@`, `playbook `, etc.). Up to 8 results.
6. **Recent** — Last 5 entities the user visited. Cleared on sign out.

#### Section ordering rule

As soon as the user types, sections re-rank by match quality. With empty input, the order above holds.

---

### 5. Intent routing

When the user presses Enter (or clicks an item), the selected item's intent determines the action:

| Intent | Item shape | Action on select |
|---|---|---|
| **Navigate** | Route reference | Push the route, close the menu. |
| **Search → Navigate** | Entity reference | Push the route to that entity's detail page. |
| **Action** | Capability invocation | Open the action UI (form, confirm dialog) pre-filled. Action dispatched via `contract.invoke()` from the registry, audit-logged. |
| **Template** | Prompt template + auto-submit flag | Render the template against current context, insert into Ask Drawer, optionally auto-submit. |
| **Ask** | Free-text prompt | Insert input as-is into Ask Drawer and submit. |

Default intent when the input doesn't match a known shape: **Ask**. Pressing Enter without selecting a suggestion always works — the input goes to the Ask Drawer.

#### Keyboard

| Key | Effect |
|---|---|
| `↑` / `↓` | Move selection |
| `Enter` | Activate selection |
| `Shift+Enter` | Open in new tab (for navigation/search intents only) |
| `⌘+Enter` | Force "Ask" intent regardless of selection (escape hatch when LLM-misclassified) |
| `Tab` | Cycle sections |
| `⌘+letter` | Section-level shortcuts (e.g., `⌘+N` for Navigate, `⌘+R` for Recent) |
| `Esc` | Close |

---

### 6. Prompt templates

#### What they are

A **prompt template** is a reusable, parameterized prompt that prepopulates the agent's input and (optionally) auto-submits. Templates are the primary "Quick Actions" content.

#### Schema

```ts
type PromptTemplate = {
  id: string;                          // 'create-trigger-for-event'
  title: string;                       // 'Create trigger for this event'
  description: string;                 // shown as tooltip / secondary line
  body: string;                        // Liquid-style template with {{vars}}
  variables: TemplateVariable[];       // names + types + how to resolve
  applicableTo: ContextMatcher[];      // where this template is offered
  capability?: string;                 // required capability id
  autoSubmit: boolean;                 // submit immediately or let user edit?
  category: 'create' | 'investigate' | 'configure' | 'communicate' | 'analyze';
  tags: string[];
};

type TemplateVariable = {
  name: string;                        // 'event_id'
  resolver: 'param' | 'query' | 'session' | 'page' | 'ask';
  source: string;                      // e.g., 'params.eventId'
  required: boolean;
};

type ContextMatcher = {
  routePattern: string;                // '/{org}/{ws}/automation/events/:eventId'
  scope?: 'org' | 'workspace' | 'account';
};
```

#### Where templates live

A `packages/prompt-templates` workspace package:

```
packages/prompt-templates/
├── src/
│   ├── index.ts                # registry + getApplicable(context)
│   ├── schema.ts               # zod schemas
│   └── templates/
│       ├── create-trigger.yml
│       ├── invite-teammate.yml
│       ├── connect-source.yml
│       ├── summarize-run-failure.yml
│       └── ...
├── package.json
```

Templates are YAML files for human edit-ability. They register themselves at module load. Adding a template is a PR with no migration.

```yaml
# packages/prompt-templates/src/templates/summarize-run-failure.yml
id: summarize-run-failure
title: Summarize this run's failure
description: Generate a root-cause summary for a failed run
category: investigate
tags: [run, failure, summary]
applicableTo:
  - routePattern: /{org}/{ws}/activity/runs/:runId
capability: activity.run.read
autoSubmit: true
variables:
  - name: run_id
    resolver: param
    source: params.runId
    required: true
body: |
  Summarize the failure of run {{run_id}}. Include the failing step,
  the error, and the most likely root cause based on the run's trace
  and related recent runs.
```

#### Capability gating

A template is filtered out of the Quick Actions section if the user lacks the declared `capability`. Templates without a `capability` field are universally visible.

#### Variable resolvers

| Resolver | Source | Example |
|---|---|---|
| `param` | Route param | `params.runId` from `/runs/:runId` |
| `query` | Query string | `query.tab` from `?tab=audit` |
| `session` | Current user | `session.user.id`, `session.org.slug` |
| `page` | Page-supplied context | `page.entity.name` (page registers what it represents) |
| `ask` | Prompt the user inline | Opens a one-line follow-up dialog before sending to agent |

If a required variable can't be resolved, the template is hidden from this context. (It might still appear elsewhere where the variable resolves.)

#### Rendering pipeline

```
template.body
  → Liquid render with resolved variables
  → final prompt string
  → injected into Ask Drawer input
  → if autoSubmit: dispatch send
```

Templates are static text + variable interpolation only. No conditional logic, no loops. If a template needs that complexity it's a UI form, not a prompt template.

---

### 7. Context-aware suggestions

The "Suggested for this page" section is generated by an LLM call that receives the user's current context. This is the surface that makes the agent *feel* ambient.

#### What context is sent to the LLM

```ts
type SuggestionContext = {
  route: string;                       // '/acme/prod/activity/runs/run_4221'
  routeParams: Record<string, string>; // { runId: 'run_4221' }
  queryParams: Record<string, string>; // { tab: 'trace' }
  pageEntity?: {                       // page-registered entity
    kind: string;                      // 'run' | 'playbook' | 'trigger' | ...
    id: string;
    publicId?: string;
    label?: string;                    // human-readable display name
    summary?: string;                  // 1-2 sentence machine summary
  };
  recentEntities: EntityRef[];         // last 5 visited
  capabilities: string[];              // user's effective capabilities at this scope
  locale: string;
};
```

**Important:** the LLM receives metadata, **not the full record body**. Sending raw record content has privacy and token-cost implications. The page registers a *summary* (typically 1–2 sentences plus key fields), which is what's sent.

#### Page entity registration

Each detail page declares its entity in a typed hook:

```ts
// apps/app/src/app/[org]/[ws]/activity/runs/[runId]/page.tsx
useRegisterPageEntity({
  kind: 'run',
  id: run.id,
  publicId: run.publicId,
  label: `Run ${run.publicId}`,
  summary: `Run of playbook "${playbook.name}" v${playbook.version}. Status: ${run.status}. Failed at step "${run.failedStep ?? '—'}".`,
});
```

The hook stores the entity in app-level context. The Command Menu reads it when summoning suggestions.

#### LLM call shape

- Endpoint: `POST /api/command-menu/suggestions` (server action; runs through capability check `command_menu.suggest`).
- Model: fast/cheap tier (e.g., Haiku — matches the operating-model defaults in `CLAUDE.md`).
- System prompt: a static template describing the schema of the response (4 prompts, each 5–12 words, each starts with a verb, each must be answerable by an Oxagen agent).
- Input: serialized `SuggestionContext`.
- Output: a typed array of 3–5 suggested prompts; each carries a `category` tag for icon/grouping and a `confidence` score.
- Streaming: results are *not* streamed; suggestions are short and the menu blocks on the full response (with timeout, see §10).

#### Caching

| Layer | Key | TTL | Invalidation |
|---|---|---|---|
| Client (in-memory) | `route + routeParams.entity` | 5 min | Route change clears; visible to current session only |
| Server (Vercel Runtime Cache) | hash of `SuggestionContext` minus session | 1 hour | Manual via webhook when the underlying entity changes |

Suggestions for the same record by different users share the server cache; the client cache is per-user-session.

#### Fallback when LLM is slow or unavailable

If the LLM call exceeds 800ms or errors, the section silently hides. **No spinner stays visible past 500ms.** The user's flow is never blocked on suggestions — the rest of the menu (Quick Actions, Navigate, Recent) renders in \<50ms from local data.

#### Privacy considerations

- Send only entity *summary*, never the full payload. Page authors are responsible for ensuring `summary` doesn't leak PII or sensitive fields.
- Suggestion content is **not** persisted to the audit log. The *act* of opening the menu IS audit-logged (`command_menu.open`). The *act* of submitting a suggestion IS audit-logged (`command_menu.submit` with the rendered prompt).
- Customers can opt out at org level (`/{org}/security/audit` → suggestion-LLM toggle). When off, the section never renders.

---

### 8. Quick Actions — what shows here

Quick Actions is a curated list of templates ranked by context match. Ranking input:

1. Does the template's `applicableTo` match the current route? (Hard filter.)
2. Are all required variables resolvable from current context? (Hard filter.)
3. Does the user have the template's required capability? (Hard filter.)
4. Has the user invoked this template recently? (Boost.)
5. Has the template's category been used recently in this workspace? (Boost.)

The top 6 are rendered. Each item carries:

- An icon based on `category`
- The template `title`
- Optional keyboard shortcut (assigned by the template, e.g., `⌘+E` for "Create trigger for this event")

#### Built-in template set (day 1)

Minimal template library that ships with the app:

| Template | Where it offers | Auto-submit |
|---|---|---|
| Summarize this run's failure | Run detail page | yes |
| Show similar failed runs | Run detail page | yes |
| Open source playbook | Run detail page | no (just navigates) |
| Create trigger for this event | Event detail | no (opens form) |
| Connect a data source | Knowledge/Sources, empty state | no (opens dialog) |
| Invite a teammate | Org/Members | no (opens form) |
| Explain this audit event | Audit detail | yes |
| Run this playbook | Playbook detail | no (opens param form) |
| Why is this trigger failing? | Trigger with recent failures | yes |
| Summarize this workspace's recent activity | Workspace home | yes |

This list expands over time. Adding a template is a PR with a YAML file — no UI code changes.

---

### 9. Navigation items

The Navigate section is fed by the same typed sidebar config defined in `application-shell/spec.md` §14. Every sidebar item + every tab is enumerable, so the Command Menu can offer them all by fuzzy match.

Display format:

```
{Parent} › {Child}                        e.g.  Access › Grants
Workspaces › {workspace name}             for workspace navigation
```

Permission-gated: items the user lacks the capability to view are filtered out.

---

### 10. Search

When the user's input matches an entity-prefix pattern, the menu enters Search mode and replaces Quick Actions + Navigate with results:

| Pattern | Entity kind |
|---|---|
| `run [id]` or `run_…` or `run #…` | Run |
| `@email@…` | Human principal |
| `playbook [slug]` or `pb_…` | Playbook |
| `trigger [name]` or `tg_…` | Trigger |
| `event [name]` | EventDef |
| `agent [name]` or `ag_…` | Agent |

Each result row shows: icon, label, scope (`Workspace: Production`), one-line context (status, last activity, etc.).

Backed by a single typed endpoint `POST /api/command-menu/search` that runs through the contract registry. Server-side, search composes results from the ontology and the operational tables, each filtered by the user's grants.

Performance target: **first result visible ≤120ms** for cold queries on a workspace under 100k entities.

---

### 11. Recent

Client-tracked, per-user-session. Tracks the last 5 distinct entities visited (deduped on route+params). Persisted to `localStorage` keyed by user id, cleared on sign-out.

Recent is shown only when the input is empty. As soon as the user types, Recent is replaced by ranked results.

---

### 12. Submit → Agent handoff

When the user activates an item with intent `Template` or `Ask`:

1. Command Menu closes.
2. Ask Drawer opens (if not already open).
3. Rendered prompt is inserted into the drawer's input.
4. If the template has `autoSubmit: true` or the intent was `Ask`, the prompt submits to the agent immediately.
5. The drawer scopes its conversation to the page's current entity (if any).

Conversation persistence is handled by the Ask Drawer; the Command Menu doesn't own conversation state.

---

### 13. Audit + observability

Every interaction with the menu writes to the audit log via the contract registry:

| Event | Capability | Payload (audited) |
|---|---|---|
| Open | `command_menu.open` | `{ route }` |
| Suggestion request | `command_menu.suggest` | `{ route, entity_kind, entity_id }` (no prompt content) |
| Suggestion shown | (none — not audited) | local telemetry only |
| Template invoked | matches template's `capability` | `{ template_id, rendered_prompt_hash, variables_resolved }` |
| Free-form Ask submitted | `agent.ask` | `{ prompt }` (full prompt) |
| Navigate selected | (none — read-only) | local telemetry only |

The audit log is the source of truth for "what did the user do via the menu?" — useful for both compliance and product analytics.

---

### 14. Accessibility

- Overlay container: `role="dialog"`, `aria-modal="true"`, `aria-labelledby="cmdk-title"`.
- Input is auto-focused on open.
- Result list uses combobox pattern: `role="listbox"` on the list, `role="option"` on rows, `aria-activedescendant` on input.
- Section headers are `<h3 id="...">` with `aria-labelledby` on the listbox group.
- Keyboard order: `Esc` closes from anywhere; `Tab` cycles through sections; `↑↓` navigates within a section.
- Screen-reader announcements:
  - On open: "Command menu opened. Type to search, or use arrow keys."
  - When suggestions arrive: "\{n} suggestions available."
  - When section changes via Tab: "\{section name}, \{n} items."
- Color contrast: input ≥7:1, items ≥4.5:1, selected item ≥7:1.
- Respect `prefers-reduced-motion` — disable scale animations.

---

### 15. Performance budgets

| Step | Budget |
|---|---|
| Open animation start → input focused | ≤80ms |
| Local sections (Navigate, Recent, Quick Actions) → rendered | ≤50ms |
| LLM Suggested section → rendered | ≤800ms typical, hide if not back by then |
| Search query → first result | ≤120ms (workspaces under 100k entities) |
| Selection → action begins | ≤16ms (one frame) |
| Bundle size (menu JS, gzipped) | ≤22KB |

Server-side suggestion calls are cached aggressively (§7) and run on the cheap model tier. Per-request cost cap: $0.0005.

---

### 16. Component inventory

| Component | Location | Notes |
|---|---|---|
| `CommandMenu` | `apps/app/src/components/shell/command-menu/` | Root overlay. Owns input + sections. |
| `CommandMenuInput` | same | Wraps the existing Ask Bar input in dialog mode. Shares state via context. |
| `CommandMenuSection` | `@oxagen/ui` | Reusable. Header + result list with WAI-ARIA combobox. |
| `CommandMenuItem` | `@oxagen/ui` | Reusable row. Icon + label + secondary + shortcut. |
| `useCommandMenuContext` | `apps/app/src/lib/command-menu/` | Hook that resolves current page entity, route params, capabilities. |
| `useRegisterPageEntity` | same | Hook every detail page calls to register itself for context. |
| `getApplicableTemplates` | `packages/prompt-templates` | Server + client. Filters templates by context + capabilities. |
| `renderTemplate` | same | Liquid render of a template against resolved variables. |
| `useSuggestions` | `apps/app/src/lib/command-menu/` | Calls suggestion endpoint, caches results. |

---

### 17. Edge cases

| Case | Behavior |
|---|---|
| Network offline | LLM section hides; everything else works from local data. |
| User has zero recent entities | Recent section hides. |
| Page didn't register an entity | LLM context omits `pageEntity`; suggestions are page-level not record-level. |
| No quick actions apply to the current route | Quick Actions section hides; menu shrinks. |
| Input is gibberish that doesn't match any pattern | Default intent = Ask. Enter ships it to the drawer. |
| User opens menu while Ask Drawer is mid-conversation | Menu opens normally. Activating an Ask item appends to the existing conversation (does not start a new one). |
| Capability denied during template submit | Drawer shows an inline error with a "Request access" CTA that submits a JIT request (per IA §6 Access). |
| Two templates have the same shortcut | First-registered wins. CI check prevents collisions. |

---

### 18. Non-goals (for v2 launch)

- User-authored templates (templates are repo-owned for now; user-authored is a future).
- Per-workspace template overrides.
- Template versioning UI (git is the version history for now).
- Inline template editor in the app.
- Marketplace / community templates.
- Voice input.

---

### 19. Validation criteria

The Command Menu is ready to ship when:

- [ ] `⌘K` opens from every authenticated page including the Ask Drawer.
- [ ] All four intents route correctly (Navigate, Search, Template, Ask).
- [ ] Suggestions render within 800ms on the median, or hide silently.
- [ ] Page entity registration works on at least 6 detail pages (Run, Playbook, Trigger, Event, Agent, OntologyNode).
- [ ] At least the 10 built-in templates ship and pass schema validation in CI.
- [ ] Capability gating verified: a Viewer cannot see Admin-only templates or navigate to Admin-only pages.
- [ ] Audit log records the events in §13 with the documented payloads.
- [ ] WAI-ARIA combobox pattern verified with screen reader (VoiceOver + NVDA).
- [ ] Performance budgets in §15 met on staging.
- [ ] Org-level "Disable LLM suggestions" toggle works end-to-end.

---

### 20. Changelog

- 2026-05-29 — Initial specification.
- 2026-05-30 — §5 intent routing: `withCapabilityCheck` → `contract.invoke()` from registry.

