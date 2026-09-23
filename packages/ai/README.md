# @oxagen/ai

Every LLM call in the platform (streaming completions, structured object generation, and embeddings) goes through this package's helpers, so admission, metering, performance tracking, and customer billing happen in one place.

## Boundary

- **Owns:** the metered wrappers over the Vercel AI SDK (`streamAgentReply`, `generateObjectFor`, `embedText`, `embedMany`); model selection and tier resolution (`selectModel`, `modelIdOf`, `selectModelForOrg`); the model catalog and provider posture matrix; who funds an organisation's calls (ADR-053) and per-organisation OpenRouter key provisioning (ADR-131); the prompt registry, slash commands, and `@`-mention grammar; the opt-in response cache; and the token-free credential probe.
- **Does not own:**
  - IAM, which runs at the kernel's `invoke()` before a handler calls in here: [`@oxagen/oxagen`](../oxagen/README.md) and [`@oxagen/iam`](../iam/README.md).
  - Usage admission, settlement, credit charging, and the price book: [`@oxagen/billing`](../billing/README.md). This package calls `admitUsage`, `finalizeUsage`, and `voidUsage` there (ADR-134).
  - The ClickHouse token-usage rows: [`@oxagen/telemetry`](../telemetry/README.md).
  - The agent turn loop and tool materialisation: [`@oxagen/agent`](../agent/README.md).
  - The stored assistant key row: [`@oxagen/database`](../database/README.md) (`./assistant-model-key`).
- **Depends on:**
  - `@oxagen/billing`: usage admission and settlement, provider cost, and `CREDIT_REASONS`.
  - `@oxagen/telemetry`: token-usage rows, cache events, and error capture.
  - `@oxagen/database`: model defaults, stored model credentials, and the assistant key row.
  - `@oxagen/tenancy`: tenant scope for usage writes.
  - `@oxagen/config`: env readers (`OXAGEN_LLM_*`, `AI_GATEWAY_API_KEY`) and the outbound URL guard.
  - `@oxagen/oxagen`: context types.
- **Used by:** `apps/api` (declared), `apps/app_deprecated`, `@oxagen/agent`, `@oxagen/handlers`, `@oxagen/ingestion`, `@oxagen/inngest-functions`, and `tools/scripts`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `streamAgentReply`, `generateObjectFor`, `embedText`, `embedMany` | boundary | `packages/ai/src/stream.ts`, `generate-object.ts`, `embed.ts` | The only sanctioned path to a model. Called from `packages/agent`, `packages/handlers`, `packages/ingestion`, and `packages/inngest-functions` |
| Usage admission and settlement | adapter | `packages/ai/src/record-token-usage.ts` | Calls `admitUsage` before the provider call (in `streamText`'s `prepareStep`) and `finalizeUsage` or `voidUsage` after, from `packages/billing/src/usage-outbox.ts` |
| `selectModel`, `modelIdOf` | export | `packages/ai/src/models.ts` | Every caller that needs a model or its id. Hard-coded provider slugs are not allowed |
| `resolveModelFundingSource`, `selectModelForOrg` | export | `packages/ai/src/funding-source.ts`, `select-model-for-org.ts` | `packages/agent/src/runtime/assistant-turn.ts` resolves which key funds an organisation's turn |
| `ensureAssistantModelKey` | export | `packages/ai/src/assistant-key-provision.ts` | `packages/handlers/src/assistant-key-bootstrap.ts` and `tools/scripts/assistant-model-keys.ts` |
| AI SDK re-exports (`tool`, `jsonSchema`, `stepCountIs`, `Tool`, `ToolSet`, `ModelMessage`) | boundary | `packages/ai/src/index.ts` | Lets tool-building code avoid its own `ai` import |

## Entry points

| Subpath | Provides |
|---|---|
| `.` | Root barrel: `streamAgentReply`, `generateObjectFor`, `embedText`, `embedMany`, the model selectors, funding-source resolution, the prompt registry, the response cache, `probeModelCredential`, and the AI SDK re-exports |
| `./catalog` | Typed model catalog: `gatewayModels`, tier helpers, capability flags. Client-safe |
| `./posture` | Provider capability posture matrix: cache, reasoning, structured-output, and attachment support per vendor. Client-safe |
| `./slash-commands` | Chat slash-command registry. Client-safe |
| `./mentions` | `@`-mention reference grammar (parse, serialize, render). Client-safe |
| `./key-provisioning` | `ensureAssistantModelKey`: gives one organisation its own OpenRouter key (ADR-131) |
| `./openrouter-provisioning` | The OpenRouter key-management calls. The only reader of `OPENROUTER_MANAGEMENT_KEY` |
| `./assistant-key-name` | The name an organisation's key carries in the OpenRouter account |

## What this is

`@oxagen/ai` wraps the Vercel AI SDK calls the platform makes (`streamText`, `generateObject`, `embed`, and `embedMany`) behind a typed facade. Callers get the same streaming and structured-output ergonomics as the raw SDK, and the boundary layer also:

- Admits each provider call against the organisation's usage before contacting the provider, then settles it through `@oxagen/billing` (ADR-134)
- Records token usage and latency to `@oxagen/telemetry`
- Selects the model from a centrally maintained catalog so model IDs are never scattered across the codebase

IAM checks happen earlier, at the capability kernel's `invoke()` boundary (`packages/oxagen`), before a handler ever calls into this package.

```
caller → capability handler → @oxagen/ai helper [admit usage] → AI Gateway → provider → [settle usage · telemetry] → billing
```

## Install / import

Workspace-internal package. Add `"@oxagen/ai": "workspace:*"` to the consuming package's dependencies.

## Model catalog

Model IDs are maintained in `src/catalog.ts`. The catalog is the single source of truth for what a model can do (the `capabilities` array). The `OXAGEN_LLM_*` env vars own the concrete model each tier resolves to (server-only, see `src/models.ts`). The defaults below come from `packages/config/src/env.ts`.

| Tier | Env var | Default |
|---|---|---|
| `fast` | `OXAGEN_LLM_FAST` | `anthropic/claude-haiku-4.5` |
| `balanced` | `OXAGEN_LLM_BALANCED` | `anthropic/claude-sonnet-5` |
| `precise` | `OXAGEN_LLM_PRECISE` | `anthropic/claude-fable-5` |

ADR-043 removed image and video generation, so text is the only tier family.

## Source layout

- `src/stream.ts`: `streamAgentReply()` wraps `streamText`, admits and meters tokens, and emits telemetry. It does no IAM check.
- `src/generate-object.ts`: `generateObjectFor()`, structured output via a Zod schema, with the same metering as stream.
- `src/embed.ts`: `embedText()` and `embedMany()`, text embedding via `openai/text-embedding-3-small` on the gateway. Meters embedding tokens.
- `src/record-token-usage.ts`: the admission and settlement calls into `@oxagen/billing`.
- `src/models.ts`: `selectModel()`, the gateway model factory. Reads the tier env vars.
- `src/funding-source.ts`, `src/select-model-for-org.ts`: who pays for an organisation's calls, and the model on that key (ADR-053).
- `src/assistant-key-provision.ts`, `src/openrouter-provisioning.ts`, `src/assistant-key-name.ts`: per-organisation OpenRouter keys (ADR-131).
- `src/catalog.ts`: the `gatewayModels` constant and capability helpers. Client-safe (no provider SDK imports).
- `src/load-effective-model-defaults.ts`: server-only. Loads user and workspace model preferences from the database.
- `src/resolve-model-defaults.ts`: pure resolver for model defaults. Client-safe.
- `src/provider-posture.ts`: per-vendor capability posture matrix (cache, reasoning, structured output, attachments). Client-safe.
- `src/cache.ts`: opt-in exact and semantic response cache for deterministic background inference.
- `src/output-budget.ts`: the typed error and retry for a request the vendor refused because the balance cannot fund its output ceiling. The retry asks again with the ceiling the refusal named.
- `src/credential-probe.ts`: token-free check of a customer's model-vendor key.
- `src/prompts/`: prompt registry, slash commands, and the `@`-mention grammar.
- `src/index.ts`: root barrel re-exporting the public helpers.

## Dependencies

**External:** `ai`, `@ai-sdk/gateway`, `@ai-sdk/provider`, `@ai-sdk/openai-compatible`, `@opentelemetry/api`, `zod`, `drizzle-orm`. Read `package.json` for versions.

**Workspace:** see [Boundary](#boundary).

## Design notes

**Why does the chokepoint exist?**

With no single boundary, metering drifts apart. One caller bills correctly, the next forgets to record tokens, and a third calls a provider nobody meters. Every surface (app, API, MCP, CLI) has to bill the same way, and the reliable way to get that is to make every call go down the same path. A new surface inherits metering by calling these helpers.

**Can I call the Vercel AI SDK directly in a handler?**

No. Calling `streamText`, `generateObject`, `generateText`, or `embed` straight from `ai`, or reaching for a provider SDK, skips metering, so the organisation is never billed for that call. Use the helpers this package exports instead.

Importing the SDK for its *types* (`ModelMessage`, `ToolSet`, `Tool`) is fine, and so is `tool`, `jsonSchema`, and `stepCountIs`. This package re-exports those three from its root barrel so tool-building code does not need its own `ai` import. A caller with tools must pass a `stopWhen` predicate built with `stepCountIs`. The AI SDK default stops after the first step, so the model never reads the tool result.

This rule is a convention, not a gate: nothing in ESLint or CI fails a build that imports the call functions directly. Check by hand in review.

**Which credentials reach a provider.**

The Vercel AI Gateway (`@ai-sdk/gateway`) is the default path for every call type, and `AI_GATEWAY_API_KEY` is the only credential it needs. One path deliberately leaves it:

- Set `OXAGEN_MODEL_PROVIDER=openrouter` and *language* calls go straight to OpenRouter with `OPENROUTER_API_KEY`. This is an explicit operator opt-out for a deployment that cannot reach the gateway, never an automatic failover, because a silent failover would move spend onto another vendor's bill and skip the metering the gateway exists to provide. Embedding calls stay on the gateway and therefore still fail on such a deployment, visibly.

An organisation's own key, or the OpenRouter key Oxagen provisioned for it, can also serve its calls. `selectModelForOrg` resolves which one (ADR-053, ADR-131).

## Tests

```bash
pnpm --filter @oxagen/ai test:unit src/stream.test.ts
```

Never put `--` before the filename. Tests live beside the source in `src/`. CI runs typecheck, lint, the full unit suite, and coverage. Do not run them package-wide on the shared machine.
