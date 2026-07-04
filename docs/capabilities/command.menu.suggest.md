# command.menu.suggest

**Domain:** command
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, agent
**Risk level:** low

## Intent

Generate 3–5 context-aware "Suggested for this page" prompts for the Command Menu using a fast/cheap LLM tier. Accepts a SuggestionContext describing the user's current page (route, page entity summary, recent entities, effective capabilities) and returns short, verb-first prompts an Oxagen agent can answer. Privacy: only `pageEntity.summary` is sent to the model, never the full record body; when the org has opted out of LLM suggestions the handler returns `[]` without calling the LLM; suggestion content is not persisted.

## Input

| Field | Type | Notes |
|---|---|---|
| `route` | `string` | The current route (max 2000 chars). |
| `routeParams` | `object` | Extracted route params. Default `{}`. |
| `queryParams` | `object` | Current query-string params. Default `{}`. |
| `pageEntity` | `object?` | The entity the page is "about", if registered (optional). |
| `pageEntity.kind` | `string` | Entity kind. |
| `pageEntity.id` | `string` | Entity id. |
| `pageEntity.publicId` | `string?` | Prefixed public identifier (optional). |
| `pageEntity.label` | `string?` | Human-readable display name (optional). |
| `pageEntity.summary` | `string?` | 1–2 sentence machine summary — the ONLY entity data sent to the LLM (max 500 chars) (optional). |
| `recentEntities` | `EntityRef[]` | Last 5 entities visited in this session. Default `[]`. |
| `capabilities` | `string[]` | User's effective capability ids at the current scope (max 200). Default `[]`. |
| `locale` | `string` | BCP-47 locale string. Default `"en"`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `suggestions` | `Suggestion[]` | 0–5 generated prompts (empty when the org opted out). |
| `suggestions[].text` | `string` | Verb-first prompt, 5–12 words (3–200 chars). |
| `suggestions[].category` | `enum` | Semantic category: create, investigate, configure, communicate, analyze. |
| `suggestions[].confidence` | `number` | LLM confidence in relevance (0–1). |

## Roles

Org Owner, Org Admin, Org Member, Workspace Owner, Workspace Member, Workspace Viewer.

## Side effects

None persisted. Calls a fast LLM tier with only the entity summary; suggestion content is not stored. ClickHouse logs the act of calling (not the returned content).

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. route over 2000 chars, summary over 500 chars). |
| `unauthorized` | Caller lacks the required org/workspace role. |
