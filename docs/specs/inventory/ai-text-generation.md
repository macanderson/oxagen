# Spec: ai-text-generation

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: packages/ai/src/{index.ts, stream.ts, generate-object.ts, embed.ts, prompts/registry.ts, prompts/load-config.ts, models.ts}
> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Stream text replies with telemetry instrumentation
<!-- id: stream.streamAgentReply -->
<!-- entities: LanguageModel, ModelMessage, ToolSet, Surface -->
<!-- enforced: stream.streamAgentReply() -->
<!-- test: stream.test.ts (multiple test cases) -->

When a caller invokes `streamAgentReply`, the function SHALL stream text output from a language model through the Vercel AI Gateway, capture reasoning/thinking tokens when effort is specified, and instrument the call with telemetry (token usage, cost, duration) and billing charges. The function returns a StreamTextResult that the caller can consume via `fullStream` or `textStream`.

#### Scenario: Basic text streaming with telemetry
<!-- test: stream.test.ts.streamAgentReply captures usage -->
- **WHEN** streamAgentReply is called with messages, a model, telemetry context (orgId, workspaceId, surface, messageId), and no special reasoning effort
- **THEN** streamText emits the reply, and after the stream completes, onFinish callback writes exactly one token_usage row to ClickHouse with model id, provider, input/output/cached token counts, cost in micro-USD, duration_ms, surface origin, and prompt hash

#### Scenario: Reasoning-enabled request with vendor-specific config
<!-- test: stream.test.ts.reasoningRequestConfig generates appropriate providerOptions -->
- **WHEN** streamAgentReply receives effort="high" (or "low"/"medium") for an Anthropic model (anthropic/claude-opus-4.8)
- **THEN** reasoningRequestConfig returns providerOptions with anthropic.thinking={type:"adaptive"} and outputConfig.effort set, AND temperature is locked (must be omitted from the streamText call) to avoid provider rejection

#### Scenario: OpenAI reasoning effort mapping
<!-- test: stream.test.ts -->
- **WHEN** streamAgentReply receives effort="high" for an OpenAI reasoning model (openai/gpt-5.x)
- **THEN** reasoningRequestConfig returns providerOptions with openai.reasoningEffort="high" and reasoningSummary="detailed" to stream reasoning deltas into fullStream, AND temperature is locked

#### Scenario: Google Gemini thinking support
<!-- test: stream.test.ts -->
- **WHEN** streamAgentReply receives effort="medium" for a Google model
- **THEN** reasoningRequestConfig returns providerOptions with google.thinkingConfig={includeThoughts:true, thinkingBudget:8192} and temperature is NOT locked (caller may override)

#### Scenario: System prompt ephemeral cache optimization
<!-- test: stream.test.ts -->
- **WHEN** a system prompt is provided, the call uses an Anthropic model, and the prompt is above the provider's minimum cacheable size
- **THEN** the system is inserted as a leading system message with providerOptions.anthropic.cacheControl={type:"ephemeral"}, and subsequent turns in the conversation read the prefix from cache at ~1/10th the input token cost

#### Scenario: Tenant scope captured before async completion
<!-- test: stream.test.ts -->
- **WHEN** streamAgentReply is invoked inside an active AsyncLocalStorage tenant scope (orgId, workspaceId)
- **THEN** the scope is captured synchronously before the stream starts, so onFinish can re-establish it via runInTenantScope and credit charges succeed inside that scope

#### Scenario: Billing failure does not fail user turn
<!-- test: stream.test.ts -->
- **WHEN** chargeUsageCredits throws during onFinish (DB unavailable, scope error, etc.)
- **THEN** the error is logged but swallowed; the stream completion and reply to the user proceed normally

#### Scenario: Telemetry failure does not fail user turn
<!-- test: stream.test.ts -->
- **WHEN** insertTokenUsage throws during onFinish (ClickHouse unreachable, network error, etc.)
- **THEN** the error is logged but swallowed; the stream completion and reply to the user proceed normally

#### Scenario: Cached input tokens forwarded to billing
<!-- test: stream.test.ts -->
- **WHEN** prompt caching engages and the AI SDK v6 event.totalUsage reports cachedInputTokens > 0
- **THEN** the cached token count is forwarded to providerCostUsdMicros and insertTokenUsage so the rate card prices cached tokens at the cheaper cached rate instead of full rate

---

### Requirement: Generate structured objects with telemetry
<!-- id: generate-object.generateObjectFor -->
<!-- entities: Schema<T>, LanguageModel, ModelMessage, Surface -->
<!-- enforced: generate-object.generateObjectFor() -->
<!-- test: generate-object.test.ts (multiple test cases) -->

When a caller invokes `generateObjectFor`, the function SHALL call the AI SDK generateObject primitive, return a typed object and usage metrics, and instrument the call with telemetry (token usage, cost, duration) and billing charges. Telemetry is best-effort and must never fail the caller.

#### Scenario: Generate structured output from prompt
<!-- test: generate-object.test.ts.generateObjectFor returns object and usage -->
- **WHEN** generateObjectFor is called with a Zod schema, a plain-text prompt, and telemetry context
- **THEN** the model generates and returns a typed object matching the schema, and immediately writes a token_usage row to ClickHouse with model, provider, input/output token counts, cost, duration_ms, surface, and prompt hash

#### Scenario: Generate from message history
<!-- test: generate-object.test.ts -->
- **WHEN** generateObjectFor is called with a messages array (conversation history) instead of a plain prompt
- **THEN** the last user message in the history is extracted for prompt hashing, generateObject is invoked with messages (not prompt), and the usage is recorded with that same hashed text

#### Scenario: Default temperature for structured output
<!-- test: generate-object.test.ts -->
- **WHEN** generateObjectFor is called without an explicit temperature
- **THEN** temperature defaults to 0 (lowest randomness, for deterministic structured output)

#### Scenario: Billing debit after generation
<!-- test: generate-object.test.ts -->
- **WHEN** generateObject completes and returns usage data
- **THEN** chargeUsageCredits is called with the calculated cost (model, inputTokens, outputTokens, cachedTokens), and any charge failure is logged but does not prevent the caller from receiving the object

#### Scenario: Cost calculation includes cached tokens
<!-- test: generate-object.test.ts -->
- **WHEN** prompt caching engages and cachedInputTokens > 0
- **THEN** cachedInputTokens are extracted from result.usage, passed to providerCostUsdMicros for discounted pricing, and forwarded to insertTokenUsage

---

### Requirement: Embed text with metering
<!-- id: embed.embedText -->
<!-- entities: EmbeddingModel, Surface -->
<!-- enforced: embed.embedText() -->
<!-- test: embed.test.ts -->

When a caller invokes `embedText`, the function SHALL embed a text string using the pinned embedding model (text-embedding-3-small) via the Vercel AI Gateway, return a 1536-dimensional vector, and write one token_usage row to ClickHouse for metering. Embeddings are input-only (output tokens = 0).

#### Scenario: Generate and return 1536-dim vector
<!-- test: embed.test.ts.embedText returns vector of correct length -->
- **WHEN** embedText is called with a string and telemetry context
- **THEN** the gateway embedding model openai/text-embedding-3-small is invoked, and a 1536-element floating-point vector is returned

#### Scenario: Always meter embedding with telemetry
<!-- test: embed.test.ts.embedText always writes token_usage -->
- **WHEN** embedText completes
- **THEN** exactly one token_usage row is written to ClickHouse with the org, workspace, surface, execution_step_id, model name, token count, cost (input-only), duration, and prompt hash of the input text

#### Scenario: Gateway model is pinned
<!-- id: embed.embedText -->
- **WHEN** embedText is called
- **THEN** the gateway model openai/text-embedding-3-small (GATEWAY_MODEL constant) is always used; there is no caller override or tier selection

#### Scenario: Telemetry failure does not block embedding return
<!-- test: embed.test.ts -->
- **WHEN** insertTokenUsage throws (ClickHouse down, etc.)
- **THEN** the error is logged but swallowed; the 1536-dim vector is returned to the caller

---

### Requirement: Resolve system prompts with workspace overrides
<!-- id: prompts/registry.resolvePrompt -->
<!-- entities: PromptKey, PromptConfig, OverridablePromptKey -->
<!-- enforced: prompts/registry.resolvePrompt() -->

When resolvePrompt is called with a baseline prompt, a key, and optional workspace configuration, the function SHALL apply configuration-driven overrides and appendages in a strict tier order: baseline → full replacement (if overridable and override exists) → append workspace instructions (always).

#### Scenario: Baseline passthrough when no config
<!-- test: prompts/registry.test.ts (implicit via callers) -->
- **WHEN** resolvePrompt is called with baseline="You are X" and no config (config=null or undefined)
- **THEN** the baseline is returned unchanged

#### Scenario: Full replacement for overridable prompts
<!-- test: prompts/registry.test.ts (implicit via callers) -->
- **WHEN** resolvePrompt is called with key="conversation.title" (overridable), and config.overrides={conversation.title:"Custom titler"} is set
- **THEN** the override fully replaces the baseline; the custom text becomes the system prompt before appending workspace instructions

#### Scenario: Append-only for structural prompts
<!-- test: prompts/registry.test.ts -->
- **WHEN** resolvePrompt is called with key="chat.system" (NOT overridable, structural), and config.overrides={chat.system:"Bogus"} is set
- **THEN** the override is ignored; chat.system remains the baseline, and only workspace.additionalInstructions are appended (if any)

#### Scenario: Always append workspace instructions
<!-- test: prompts/registry.test.ts -->
- **WHEN** resolvePrompt is called with additionalInstructions="Tell the user about Q&A mode", for ANY key
- **THEN** the final prompt is: baseline (or overridden) + "\n\n---\n\n## Workspace instructions\n\n" + additionalInstructions

#### Scenario: Empty or whitespace overrides are skipped
<!-- test: prompts/registry.test.ts -->
- **WHEN** config.overrides={svg.generate:""} or config.overrides={svg.generate:"  \n"} (overridable key, but empty/whitespace)
- **THEN** the override is rejected, and the baseline is used in its place

---

### Requirement: Load workspace-scoped prompt configuration from database
<!-- id: prompts/load-config.loadWorkspacePromptConfig -->
<!-- entities: Workspace, PromptConfig -->
<!-- enforced: prompts/load-config.loadWorkspacePromptConfig() -->
<!-- test: load-effective-model-defaults.test.ts (mirrors pattern) -->

When loadWorkspacePromptConfig is called with a workspaceId, the function SHALL query the database for workspace.settings.promptConfig, normalize the JSONB blob, validate field types, and return a typed PromptConfig. Missing workspace, missing settings, or invalid JSON resolve to an empty config (no overrides, no appended instructions).

#### Scenario: Load configuration from workspace settings
<!-- test: load-effective-model-defaults.test.ts -->
- **WHEN** loadWorkspacePromptConfig(workspaceId) is called and the workspace exists with settings={promptConfig:{additionalInstructions:"Help users focus on ROI"}}
- **THEN** the configuration is loaded, normalized (field type validation), and returned as a PromptConfig object

#### Scenario: Handle missing workspace
<!-- test: load-effective-model-defaults.test.ts -->
- **WHEN** loadWorkspacePromptConfig(workspaceId) is called and no workspace row exists
- **THEN** an empty PromptConfig {} is returned (no error thrown)

#### Scenario: Normalize untrusted JSONB
<!-- test: load-effective-model-defaults.test.ts -->
- **WHEN** workspace.settings.promptConfig contains { additionalInstructions: 123, overrides: "not an object" } (wrong types)
- **THEN** normalizePromptConfig rejects invalid fields and returns only the valid string fields, with invalid types coerced to null or omitted

#### Scenario: Null workspaceId returns empty config
<!-- test: load-effective-model-defaults.test.ts -->
- **WHEN** loadWorkspacePromptConfig(null) is called
- **THEN** an empty PromptConfig {} is returned immediately (no DB query)

---

### Requirement: Select language model via tier or explicit id
<!-- id: models.selectModel -->
<!-- entities: LanguageModel, ModelSelector, OxagenTier -->
<!-- enforced: models.selectModel() -->
<!-- test: models.test.ts -->

When selectModel is called with an optional tier or explicit model id, the function SHALL resolve the tier to a concrete gateway model id from environment variables, build the language model via @ai-sdk/gateway, and apply devtools middleware in development. The model is always returned without direct-provider fallback.

#### Scenario: Default to balanced tier
<!-- test: models.test.ts.selectModel defaults to balanced tier -->
- **WHEN** selectModel() is called with no arguments
- **THEN** the balanced tier (OXAGEN_LLM_BALANCED env var, default anthropic/claude-sonnet-5) is resolved and the gateway language model is returned

#### Scenario: Explicit tier selection
<!-- test: models.test.ts.selectModel handles tier param -->
- **WHEN** selectModel({tier:"precise"}) is called
- **THEN** the precise tier (OXAGEN_LLM_PRECISE env var, default anthropic/claude-opus-4.8) is resolved and the gateway model is returned

#### Scenario: Explicit model id overrides tier
<!-- test: models.test.ts -->
- **WHEN** selectModel({model:"openai/gpt-5.2"}) is called
- **THEN** the explicit model id "openai/gpt-5.2" is used; the tier selector is bypassed

#### Scenario: Devtools middleware applied in development
<!-- test: models.test.ts -->
- **WHEN** selectModel is called in a NODE_ENV=development environment
- **THEN** the model is wrapped with @ai-sdk/devtools middleware, and LLM calls become visible at http://localhost:4983; the middleware is no-op in production

#### Scenario: Gateway routing and auth
<!-- test: models.test.ts -->
- **WHEN** selectModel builds a model
- **THEN** the returned LanguageModel routes all inference through the Vercel AI Gateway; the gateway client reads AI_GATEWAY_API_KEY from environment and surfaces auth errors at call time (not at selectModel time)

---

### Requirement: Resolve model tier to concrete gateway id
<!-- id: models.tierModelId -->
<!-- entities: OxagenTier -->
<!-- enforced: models.tierModelId() -->
<!-- test: models.test.ts -->

When tierModelId is called with an OxagenTier ("fast", "balanced", "precise"), the function SHALL read the corresponding OXAGEN_LLM_* environment variable and return the concrete gateway model id. The function is public and used by UI components to label the tier with its underlying model.

#### Scenario: Fast tier resolves to fast env var
<!-- test: models.test.ts -->
- **WHEN** tierModelId("fast") is called and OXAGEN_LLM_FAST=anthropic/claude-haiku-4.5 is set
- **THEN** "anthropic/claude-haiku-4.5" is returned

#### Scenario: Precise tier with default fallback
<!-- test: models.test.ts -->
- **WHEN** tierModelId("precise") is called and OXAGEN_LLM_PRECISE is unset
- **THEN** the default fallback "anthropic/claude-sonnet-5" is returned (defensive coalesce in tierFromEnv)

---

### Requirement: Resolve all white-labeled tiers to concrete models in one read
<!-- id: models.resolvedTierCatalog -->
<!-- entities: ResolvedTierCatalog, OxagenTier, MediaTier -->
<!-- enforced: models.resolvedTierCatalog() -->
<!-- test: models.test.ts -->

When resolvedTierCatalog is called, the function SHALL read all OXAGEN_LLM_* environment variables once and return a single serializable object containing the concrete gateway model ids for all text tiers (fast, balanced, precise) and media tiers (basic, advanced for both image and video). This is called once at RSC initialization so the client model picker can label tiers without touching environment variables.

#### Scenario: Catalog aggregates all tiers
<!-- test: models.test.ts -->
- **WHEN** resolvedTierCatalog() is called
- **THEN** a ResolvedTierCatalog object is returned with structure: {text:{fast:..., balanced:..., precise:...}, image:{basic:..., advanced:...}, video:{basic:..., advanced:...}}

#### Scenario: Single environment read per call
<!-- test: models.test.ts -->
- **WHEN** resolvedTierCatalog() is called
- **THEN** all 7 tier environment variables (OXAGEN_LLM_FAST/BALANCED/PRECISE, OXAGEN_LLM_IMAGE_BASIC/ADVANCED, OXAGEN_LLM_VIDEO_BASIC/ADVANCED) are read in one pass and assembled

---

### Invariant: Telemetry metadata immutable after capture
<!-- entities: PromptHash, TokenUsage -->
<!-- enforced: stream.streamAgentReply(), generate-object.generateObjectFor(), embed.embedText() -->

All three telemetry-emitting functions (streamAgentReply, generateObjectFor, embedText) capture the user's message/prompt text, hash it via hashPrompt (lossy, one-way), and forward ONLY the hash to ClickHouse — never the plaintext. The plaintext remains in Postgres (chat.messages.content) under encryption at rest. This invariant ensures user data privacy while enabling prompt cohort analysis.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Embedding model is pinned to 1536-dimensional space
<!-- entities: EmbeddingModel, Vector -->
<!-- enforced: embed.embedText() -->

The embedding function always uses text-embedding-3-small (pinned via MODEL and GATEWAY_MODEL constants), which produces 1536-dimensional vectors. Any change to the model requires re-indexing the AgentMemory vector index in Neo4j, so the model id is locked in code and cannot be overridden per call.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Credit charges are best-effort, post-call, and scoped
<!-- entities: CreditCharge, TenantScope -->
<!-- enforced: stream.streamAgentReply() via chargeUsageCredits() -->

Every LLM call (streamAgentReply, generateObjectFor) calculates the cost in micro-USD based on the provider's rate card and the token usage, then calls chargeUsageCredits in a re-established tenant scope (orgId, workspaceId). If scope establishment fails, the charge is skipped and logged, but the user's call succeeds. This prevents revenue leaks (calls charged to wrong org) and ensures consistent billing even if scope context is lost across async boundaries.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: No direct-provider SDK imports in @oxagen/ai
<!-- entities: LanguageModel, EmbeddingModel, ImageModel, VideoModel -->
<!-- enforced: models.selectModel(), embed.embedText() -->

The @oxagen/ai package is the single AI SDK chokepoint. All models (language, embedding, image, video) are built via the Vercel AI Gateway (@ai-sdk/gateway); there is no direct import of Anthropic SDK, OpenAI SDK, Google SDK, etc. This constraint ensures one auth boundary (AI_GATEWAY_API_KEY), consistent model id resolution, and uniform telemetry instrumentation across all vendors and model types.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Prompt baseline control is never cached or user-modifiable at call time
<!-- entities: PromptKey, PromptConfig -->
<!-- enforced: prompts/registry.chatSystemPrompt(), prompts/registry.conversationTitlePrompt(), etc. -->

Every baseline system prompt (chat.system, conversation.title, svg.generate, image.analyze, workflow.supervisor, workflow.task, form.fill) is built by a pure function (chatSystemPrompt, conversationTitlePrompt, etc.) that takes no input except the PromptKey and optional SystemPromptContext (org/workspace slugs and names). Baselines are never cached at module scope — each call re-renders the baseline, ensuring workspace context is always fresh. The workspace prompt config (additionalInstructions, overrides) is loaded on-demand via loadWorkspacePromptConfig, providing a strict separation between platform defaults and user customization.

> Last verified: 2026-06-20 (commit 2f628504)

---

<!-- deferred: generate-image.ts, generate-video.ts, catalog.ts, resolve-model-defaults.ts, load-effective-model-defaults.ts, prompts/auto-improve.ts (7 files remain unread; mining focused on core text-generation, streaming, embedding, and prompt resolution) -->

<!-- uncertainty: reasoningRequestConfig vendor backcompat clause for unknown vendors (lines 125–134 in stream.ts) — behavior is not enforced by tests, only documented as "back-compat with previous openai-namespace behaviour"; unclear if unknown vendors should fail fast or silently degrade. Surface via code-explorer if this edge case matters. -->
