# @oxagen/functions

`@oxagen/functions` defines the provider-agnostic contracts for durable background functions: events, step contexts, function configuration, the event client, and the function factory. It holds types and one error class, and runs nothing.

## Boundary

- **Owns:** the durable-function interfaces product code depends on (`EventPayload`, `StepContext`, `DurableFunctionConfig`, `DurableFunction`, `EventClient`, `CreateFunctionFactory`) and `NonRetriableError`, the one error a handler throws to stop retries.
- **Does not own:** the Inngest client, the function registry, or any job. [`@oxagen/inngest-functions`](../inngest-functions/README.md) implements these contracts against the Inngest SDK and holds every durable function.
- **Depends on:** no `@oxagen/*` runtime dependencies.
- **Used by:** `@oxagen/inngest-functions`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `EventClient` | port | `packages/functions/src/types.ts` | `createEventClient()` in `packages/inngest-functions/src/adapter.ts` |
| `CreateFunctionFactory` and `DurableFunctionConfig` | port | `packages/functions/src/types.ts` | `createFunction` in `packages/inngest-functions/src/create-function.ts` |
| `NonRetriableError` | export | `packages/functions/src/types.ts` | Translated to the Inngest SDK's non-retriable error in `packages/inngest-functions/src/create-function.ts` |
| Provider expression strings | boundary | `packages/functions/src/types.ts` | `ConcurrencyConfig.key`, `CancelOnConfig.if`, `batchEvents.key`, and `WaitForEventOptions.match` carry the provider's own expression dialect (CEL for Inngest) |

## Entry points

- `.` (`src/index.ts`): the type barrel and `NonRetriableError`.

## Rules

- Keep this package free of any provider SDK import. A type that needs one belongs in the adapter.
- The shapes are provider-agnostic, but the four expression strings in the Seams table are not. Swapping providers means rewriting those strings even though no type changes.

## Tests

```bash
pnpm --filter @oxagen/functions test:unit src/types.test.ts
```

Never put `--` before the filename. Tests live beside the source in `src/`.
