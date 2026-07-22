# skill.draft

**Domain:** skill
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Draft a skill configuration from a natural-language description **without persisting anything**. The model synthesises the full skill shape — display name, kebab-case slug, matcher description, weight, optional category, and the instruction body — and returns it for human review. This is the AI-assisted first step of the skill setup flow: the app's skill wizard presents the draft as a prefilled form, and the confirmed configuration is saved via `skill.create`. Headless callers can feed `content` straight into `skill.create`.

## Input

| Field | Type | Notes |
|---|---|---|
| `prompt` | `string` (10–4000) | Natural-language description of what the skill should teach the agent. |
| `nameHint?` | `string` (kebab-case) | Preferred slug for the skill (e.g. `code-review`). The model derives one from the prompt if omitted. |
| `category?` | `string` | Category label (e.g. `engineering`, `writing`, `meta`). |

## Output

| Field | Type | Notes |
|---|---|---|
| `draft.displayName` | `string` | Human-readable skill title (e.g. `PR Review`). |
| `draft.slug` | `string` | Kebab-case slug derived by the model. |
| `draft.description` | `string` | One-sentence matcher description used to decide when to load the skill. |
| `draft.weight` | `"low" \| "high" \| "critical"` | Influence weight for the skill's guidance. |
| `draft.category?` | `string` | Category label, when the model assigned one. |
| `draft.body` | `string` | The instruction text that teaches the skill. |
| `content` | `string` | The assembled and validated canonical `skill.toml` document. |
| `artifact` | `object` | Parsed `SkillArtifact` projection of `content`. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Admin, Workspace Member.

## Side effects

- LLM: a model call synthesises the skill configuration (metered via `@oxagen/ai`).
- No database writes — the draft is returned for review, never persisted.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse, or the synthesised document failed canonical `skill.toml` validation. |
| `unauthorized` | Caller lacks the required org/workspace role. |
