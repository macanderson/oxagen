# eval.dataset.from_traces

**Domain:** eval
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Create an eval dataset by sampling the workspace's **real, already-metered
production run traces** — user messages that actually executed and were
billed — instead of hand-authored or synthetic prompts. This is the wedge:
score what actually ran, not a canned prompt set.

This is deliberately **not** a generic eval-platform feature bolted onto a
dataset editor. It exists because Oxagen already owns the ClickHouse metering
pipe that every other eval tool has to reconstruct from scratch — turning
that observed usage directly into an eval dataset is a one-call operation
here. Optionally filter the sample by `capabilityName` (e.g.
`chat.message.send`) and a lookback window (`sinceHours`), then cap the
sample size with `limit` for cost and noise control. Capturing the sample
itself spends no additional AI tokens.

## Input

| Field            | Type      | Default        | Notes                                                                    |
| ---------------- | --------- | -------------- | --------------------------------------------------------------------------- |
| `name`           | `string`  | required       | Dataset display name (min 1 char)                                       |
| `slug`           | `string?` | derived        | Lowercase kebab-case slug; derived from `name` when omitted             |
| `description`    | `string?` | undefined      | Optional free-text description                                          |
| `capabilityName` | `string?` | undefined      | Only sample runs whose metered capability matches (e.g. `"chat.message.send"`) |
| `sinceHours`     | `integer` | `168` (7 days) | Lookback window over the metered traces (1–2160 hours)                  |
| `limit`          | `integer` | `50`           | Cap on the number of captured cases — cost and noise control (1–500)    |

## Output

| Field       | Type     | Notes                                                                 |
| ----------- | -------- | ------------------------------------------------------------------------ |
| `datasetId` | `string` | Internal UUID of the newly created dataset                              |
| `publicId`  | `string` | Public id — pass to `eval.dataset.get` / `eval.run.start`               |
| `slug`      | `string` | Resolved slug                                                            |
| `itemCount` | `integer`| Number of trace-sourced items actually captured (may be less than `limit` when fewer matching traces exist) |

## Side effects

New dataset row plus one dataset-item row per captured trace in Postgres,
workspace-scoped, with `source: "traces"`. Each item's `metadata` carries
trace provenance (e.g. the originating message id and capability). No AI
tokens spent — `noBillingGate`.

## Errors

None explicitly defined in the contract.
