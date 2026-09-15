# user.preferences.set

The Account dialog's Preferences tab (MC spec App. E): the locale the interface renders in, the theme and the timezone dates are shown in. A partial write: only the fields sent change, and the answer is the whole set after the write, read back from the row. `get_user_preferences` reads the same set.

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

| Field | Type | Required | Constraint |
|---|---|---|---|
| `locale` | string | no | a BCP 47 language tag, 2-35 characters |
| `theme` | enum | no | `system`, `light`, `dark` |
| `timezone` | string | no | an IANA zone name |

## Output

| Field | Type | Description |
|---|---|---|
| `locale` | string | the stored language; `en` when first written without one |
| `theme` | enum | `system`, `light`, `dark` |
| `timezone` | string | the stored zone; `UTC` when first written without one |
