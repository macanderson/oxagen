# user.preferences.set

The Account dialog's Preferences tab (MC spec App. E). A partial write: only the fields sent change, and the answer is the whole set after the write, read back from the row. `get_user_preferences` reads the same set.

It is the one writer of `auth.user_preferences` (ADR-075), so every field the read returns is settable here. `update_user_preferences` was folded into it and no longer exists. `locale` is the input name for the row's `language` column, which is the name the read answers with.

Preferences follow the person across organisations, so the capability is `scoped: false` and writes `auth.user_preferences` on the system executor.

## Mode

**sync**

## Surface

- API: `PATCH /v1/user/preferences`
- MCP: `set_preferences`
- Authentication: session; the caller must carry a person (`forbidden` otherwise)
- Capability name: `set_preferences`
- Not billed (`noBillingGate: true`): a settings write is never a governed action (ADR-052 exclusion 2).

## Input

Every field is optional; an omitted field keeps its stored value. On the two
nullable model fields an explicit `null` clears the preference, which is not the
same as omitting it.

| Field | Type | Required | Constraint |
|---|---|---|---|
| `locale` | string | no | a BCP 47 language tag, 2-35 characters |
| `theme` | enum | no | `system`, `light`, `dark` |
| `timezone` | string | no | an IANA zone name |
| `fontSize` | enum | no | `small`, `medium`, `large` |
| `density` | enum | no | `compact`, `comfortable`, `spacious` |
| `enterToSubmit` | boolean | no | true submits on Enter; false inserts a newline |
| `pendingPromptBehavior` | enum | no | `queue`, `interrupt` — what a prompt typed mid-reply does |
| `defaultTextTier` | enum \| null | no | `fast`, `balanced`, `precise`; `null` clears it |
| `defaultTextModel` | string \| null | no | a model id; `null` clears it |

## Output

The whole set after the write, read back from the row.

| Field | Type | Description |
|---|---|---|
| `locale` | string | the stored language; `en` when first written without one |
| `theme` | enum | `system`, `light`, `dark` |
| `timezone` | string | the stored zone; `UTC` when first written without one |
| `fontSize` | enum | `small`, `medium`, `large`; `medium` on first write |
| `density` | enum | `compact`, `comfortable`, `spacious`; `comfortable` on first write |
| `enterToSubmit` | boolean | `false` on first write |
| `pendingPromptBehavior` | enum | `queue`, `interrupt`; `queue` on first write |
| `defaultTextTier` | enum \| null | the pinned routing tier, or `null` for workspace routing |
| `defaultTextModel` | string \| null | the pinned model id, or `null` |
