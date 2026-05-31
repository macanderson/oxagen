# form.fill

**Domain:** form
**Mode:** sync
**Scope:** tenant + workspace

## Intent

Generatively fill or suggest values for page-level form fields based on a
natural-language instruction. Returns per-field diffs — only fields the
instruction implies are changed; all others are echoed with their current value
so the caller can render a structured diff overlay without additional diffing.

## Input

| Field           | Type                                                                                         | Notes                                                              |
| --------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `route`         | `string` (min 1)                                                                             | URL route the form lives on — used for telemetry and system-prompt context. |
| `entitySummary` | `string` (optional)                                                                          | Plain-text summary of the entity being edited, e.g. "Project: Acme v2, status: active". |
| `instruction`   | `string` (min 1)                                                                             | Natural-language instruction, e.g. "Set the name to 'Acme Corp' and mark it active". |
| `fields`        | `FieldDescriptor[]` (min 1)                                                                  | Every field on the form, including its current value and type metadata. |

### FieldDescriptor

| Field     | Type                                                           | Notes                                                              |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `name`    | `string` (min 1)                                              | Machine name used as the diff key.                                 |
| `label`   | `string` (min 1)                                              | Human-readable label shown in the overlay.                         |
| `type`    | `"text" \| "textarea" \| "number" \| "select" \| "boolean"`  | Controls how the model is prompted and the proposed value typed.   |
| `current` | `unknown`                                                     | Current field value; echoed in diff even when unchanged.           |
| `options` | `{ label: string; value: string }[]` (optional)              | Required when `type === "select"`; constrains model output.        |
| `required`| `boolean` (optional)                                          | Hint to the model that this field must not be cleared.             |

## Output

| Field    | Type           | Notes                                                                   |
| -------- | -------------- | ----------------------------------------------------------------------- |
| `fields` | `FieldDiff[]`  | One entry per input field, in the same order as the input `fields` array. |

### FieldDiff

| Field      | Type      | Notes                                                                    |
| ---------- | --------- | ------------------------------------------------------------------------ |
| `name`     | `string`  | Matches the input field `name`.                                          |
| `current`  | `unknown` | The value from the input (echoed for convenience).                       |
| `proposed` | `unknown` | The model's proposed value; equals `current` when the field is unchanged.|
| `changed`  | `boolean` | `true` only when `proposed !== current` (strict equality).              |
| `reason`   | `string`  | Optional rationale for the change; omitted when the field is unchanged.  |

## Side effects

- ClickHouse: emits one `token_usage` row per call with `surface`, `orgId`,
  `workspaceId`, and `messageId` (falls back to `requestId` when not in a chat
  turn).

## Errors

The handler does not throw on model errors. Instead it returns all input fields
unchanged (`changed: false`, `proposed = current`) with a `reason` of
`"Model error — field left unchanged."` This ensures the overlay can always
render without a loading error state.

| code                   | meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `400 Bad Request`      | Input failed Zod validation (missing route, empty fields, etc.)|
| `401 Unauthorized`     | No valid session or API key.                                   |
| `403 Forbidden`        | Caller lacks `form.fill` permission for the org/workspace.     |

## SPEC references

- §10 — Ask-to-Fill flow and FillOverlay UI (apps/app)
- §7.3 — form domain handler conventions
