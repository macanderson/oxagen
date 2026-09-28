# render_chart

**Domain:** assistant
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** agent
**Risk level:** low

## Intent

The in-app assistant draws a chart, or a small dashboard of stat tiles and
charts, in its reply. It uses figures a tool already returned in the same
conversation, such as `get_spend` or `list_runs`, and names those results in
`source`. The handler checks the shape and size and returns the spec as a
fenced `oxagen-chart` block. The assistant pastes the block into its reply,
and the app draws it with the chart kit in `apps/app/src/ui/chart.tsx`, with a
table of every value under each chart.

The capability is not pinned to the assistant's tool belt. The assistant finds
it through `search_tools` with words such as chart, graph, plot, or
dashboard, and loads it with `load_tools`.

Saving a dashboard so it outlives the conversation is a separate change
(#4177).

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `title` | `string?` | Dashboard title, at most 120 characters. |
| `source` | `string` | The tool results the figures came from, at most 200 characters. The app prints it under the dashboard. |
| `tiles` | `Array<{ label, value, format?, note? }>` | At most 8 stat tiles. `value` is a number or `null`. |
| `charts` | `Array<{ title, kind, series, rows, format, unit? }>` | At most 6 charts. |
| `charts[].kind` | `line` \| `area` \| `bar` \| `stacked_bar` | Line and area for a value over time, bar to compare items, stacked bar for parts of a whole. |
| `charts[].series` | `Array<{ label }>` | 1 to 5 series, one per chart hue. |
| `charts[].rows` | `Array<{ label, values }>` | 1 to 100 rows. `values` holds one number or `null` per series, in series order. |
| `format` | `{ kind, currency? }` | `number`, `currency` (a decimal amount, with an ISO 4217 `currency`), `percent` (a 0..1 ratio), or `duration` (milliseconds). |

The request needs at least one chart or one tile.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `render` | `{ componentId: "chart", props }` | The validated spec. |
| `block` | `string` | A fenced `oxagen-chart` block holding the spec as JSON. The assistant pastes it into the reply unchanged. |

## Side effects

None. The handler reads and writes no store.

## Errors

`invalid_input` when the spec breaks the shape: a row whose value count does
not match the series count, a currency format without a code, a request with
no chart and no tile, or a serialized spec over 16,384 bytes.

## Rendering

The app parses the block only after it checks the length, and validates it
against the same limits (`packages/oxagen/src/chart-spec.ts`). A block that
fails either check prints as code with one sentence saying the chart could not
be read. A `null` value draws as a gap and prints as "Not recorded" in the
table.

## SPEC references

- ADR-221: the app takes shadcn base-maia on Base UI, including the chart kit
- `apps/app/src/features/shell/assistant-chart.tsx`: the renderer
