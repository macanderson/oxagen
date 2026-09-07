# Spec: ai-models

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Rewritten 2026-09-07 for ADR-043: image/video generation was removed from the
> platform, and with it `generate-image.ts`, `generate-video.ts`, the media
> tiers, and the stored `defaultImageModel` / `defaultVideoModel` columns. What
> remains — and all this spec describes — is the white-labeled **text** tier
> system and the effective model-default resolver.
> Source: catalog.ts, models.ts, resolve-model-defaults.ts, load-effective-model-defaults.ts

---

### Requirement: Model selection routes through Vercel AI Gateway

<!-- id: selectModel -->
<!-- entities: TextModel, OxagenTier -->
<!-- enforced: selectModel() -->
<!-- test: models.test.ts → "routes through the gateway at the balanced tier by default" -->

When a caller invokes `selectModel()` with an optional model id or tier, the function SHALL resolve the model id to a concrete Vercel AI Gateway model string and construct a `LanguageModel` via `gateway.languageModel(modelId)`. The gateway client reads `AI_GATEWAY_API_KEY` from the environment at call time.

#### Scenario: Default tier selection
<!-- test: models.test.ts → "routes through the gateway at the balanced tier by default" -->
- **WHEN** `selectModel()` is called with no arguments
- **THEN** the balanced tier env var (OXAGEN_LLM_BALANCED) is resolved to a gateway model id and passed to `gateway.languageModel()`

#### Scenario: Explicit tier selection
<!-- test: models.test.ts → "resolves the fast tier to its OXAGEN_LLM_FAST gateway id" -->
- **WHEN** `selectModel({ tier: "fast" })` is called
- **THEN** OXAGEN_LLM_FAST env var is resolved and passed to the gateway

#### Scenario: Explicit model id wins over tier
<!-- test: models.test.ts → "an explicit gateway model id wins over a tier" -->
- **WHEN** `selectModel({ model: "openai/gpt-5.2", tier: "fast" })` is called
- **THEN** the explicit model id "openai/gpt-5.2" is passed to the gateway; the tier is ignored

#### Scenario: Devtools middleware wrapping in development
- **WHEN** `process.env.NODE_ENV === "development"` and `@ai-sdk/devtools` is available
- **THEN** the returned `LanguageModel` is wrapped with devtools middleware for inspector visibility at localhost:4983

---

### Requirement: The language path may be redirected off the gateway, explicitly

<!-- id: languageProvider -->
<!-- entities: TextModel -->
<!-- enforced: languageProvider() -->

The gateway is the default and remains the platform's metered path. Setting `OXAGEN_MODEL_PROVIDER=openrouter` selects a direct OpenAI-compatible provider instead, for a deployment that cannot reach the gateway. Selection is EXPLICIT, never a fallback: an automatic failover on gateway error would silently move spend onto a different vendor's bill and bypass the metering the gateway exists to provide.

#### Scenario: Opt-out requires its own key
- **WHEN** `OXAGEN_MODEL_PROVIDER=openrouter` is set and `OPENROUTER_API_KEY` is absent
- **THEN** a precise error is thrown at selection time rather than a 401 from an unexpected provider

#### Scenario: Embeddings are not redirected
- **WHEN** the language path is redirected to OpenRouter
- **THEN** `embeddingModel` still routes through the gateway, because OpenRouter does not serve it — embedding calls fail visibly rather than being papered over

---

### Requirement: Tier env vars resolve to concrete gateway model ids

<!-- id: tierModelId -->
<!-- entities: OxagenTier, TextModel -->
<!-- enforced: tierModelId() -->
<!-- test: models.test.ts → "resolves the fast tier to its OXAGEN_LLM_FAST gateway id" -->

When a caller invokes `tierModelId(tier)`, the function SHALL read the corresponding `OXAGEN_LLM_FAST` / `OXAGEN_LLM_BALANCED` / `OXAGEN_LLM_PRECISE` env var and return its value (or fall back to a hardcoded default if the env var is missing).

#### Scenario: Read env for tier
<!-- test: models.test.ts → "resolves the precise tier to its OXAGEN_LLM_PRECISE gateway id" -->
- **WHEN** `tierModelId("precise")` is called
- **THEN** OXAGEN_LLM_PRECISE env var is read and returned

---

### Requirement: Resolved tier catalog joins every tier to a gateway model

<!-- id: resolvedTierCatalog -->
<!-- entities: TextModel -->
<!-- enforced: resolvedTierCatalog() -->
<!-- test: models.test.ts → "joins every tier to its concrete gateway model id — text only" -->

When a caller invokes `resolvedTierCatalog()`, the function SHALL read all text tier env vars and return a single `ResolvedTierCatalog` object mapping every tier to its concrete gateway model id for client-side consumption. Server-only (it reads env); the chat RSC calls it and passes the result to the client model picker as one serializable prop.

#### Scenario: Complete tier catalog
<!-- test: models.test.ts → "joins every tier to its concrete gateway model id — text only" -->
- **WHEN** `resolvedTierCatalog()` is called with all env vars set
- **THEN** result is `{ text: { fast, balanced, precise } }` with each field mapping to its gateway model id — there are no media tiers (ADR-043)

---

### Requirement: Model id is extracted defensively from model objects

<!-- id: modelIdOf -->
<!-- entities: LanguageModel -->
<!-- enforced: modelIdOf() -->

When a caller invokes `modelIdOf(model)` with a `LanguageModel` (which is `string | LanguageModelV3`), the function SHALL return the model id string. If the input is already a string, it is returned as-is. If it is an object, the `modelId` property is read from the spec.

#### Scenario: String model input
- **WHEN** `modelIdOf("anthropic/claude-opus-4.8")` is called
- **THEN** "anthropic/claude-opus-4.8" is returned

#### Scenario: Model object input
- **WHEN** `modelIdOf({ modelId: "anthropic/claude-opus-4.8", ... })` is called
- **THEN** "anthropic/claude-opus-4.8" is read from the object and returned

---

### Requirement: Gateway model catalog is indexed by id

<!-- id: getModel -->
<!-- entities: GatewayModel -->
<!-- enforced: getModel() -->
<!-- test: catalog.test.ts → "indexes every model by its gateway id" -->

The `gatewayModels` array is the single source of truth for which Vercel AI Gateway models are surfaced in the Oxagen UI and which capabilities each supports. `getModel(id)` resolves a gateway id to its catalog entry, or `undefined` for an unknown id.

#### Scenario: Known model resolves
<!-- test: catalog.test.ts → "indexes every model by its gateway id" -->
- **WHEN** `getModel("anthropic/claude-opus-4.8")` is called
- **THEN** the matching `GatewayModel` entry is returned

#### Scenario: Unknown model resolves to undefined
- **WHEN** `getModel("unknown/model")` is called
- **THEN** `undefined` is returned rather than throwing

---

### Requirement: Reasoning capability is detected from catalog

<!-- id: supportsReasoning -->
<!-- entities: GatewayModel -->
<!-- enforced: supportsReasoning() -->
<!-- test: catalog.test.ts → "reports reasoning support from the capability array" -->

When a caller invokes `supportsReasoning(model)` with a model id string or object, the function SHALL resolve the model via `getModel()` and return `true` if the `capabilities` array includes "reasoning", else `false`. Unknown model ids return `false`.

#### Scenario: Reasoning-capable model
<!-- test: catalog.test.ts → "reports reasoning support from the capability array" -->
- **WHEN** `supportsReasoning("anthropic/claude-opus-4.8")` is called
- **THEN** `true` is returned

#### Scenario: Unknown model
- **WHEN** `supportsReasoning("unknown/model")` is called
- **THEN** `false` is returned conservatively

---

### Requirement: Vision and video INPUT are distinct from media generation

<!-- id: supportsVision -->
<!-- entities: GatewayModel -->
<!-- enforced: supportsVision(), supportsVideoInput() -->
<!-- test: catalog.test.ts → "distinguishes vision (image input) from image generation" -->

A text model that accepts image or video attachments is *multimodal input*, which ADR-043 did not remove — the chat stream route still upgrades a turn to a vision-capable model when the user attaches an image. `supportsVision()` and `supportsVideoInput()` report those input capabilities and MUST NOT be confused with media generation, which no longer exists on the platform.

#### Scenario: Vision input is not image generation
<!-- test: catalog.test.ts → "distinguishes vision (image input) from image generation" -->
- **WHEN** `supportsVision("anthropic/claude-opus-4.8")` is called
- **THEN** `true` is returned, while the model generates no images

#### Scenario: Video input is not video generation
<!-- test: catalog.test.ts → "distinguishes video INPUT (Gemini) from video generation (Veo)" -->
- **WHEN** `supportsVideoInput("google/gemini-3-pro")` is called
- **THEN** `true` is returned for the input capability

---

### Requirement: Model defaults are resolved from user and workspace preferences with precedence

<!-- id: resolveModelDefaults -->
<!-- entities: User, Workspace, ModelDefaults -->
<!-- enforced: resolveModelDefaults() -->
<!-- test: resolve-model-defaults.test.ts → "returns all null and false override flags when both user and workspace are null" -->

When a caller invokes `resolveModelDefaults(input)` with user and workspace preference objects, the function SHALL apply cascade precedence: workspace value wins over user value, explicit model wins over tier, null is preserved. Text is the ONLY dimension — the function returns `text.tier`, `text.model`, and an `overriddenByWorkspace.text` flag indicating whether the workspace set the dimension.

#### Scenario: All-null defaults
<!-- test: resolve-model-defaults.test.ts → "returns all null and false override flags when both user and workspace are null" -->
- **WHEN** `resolveModelDefaults({ user: null, workspace: null })` is called
- **THEN** both text fields are null and the override flag is false

#### Scenario: User preferences only
<!-- test: resolve-model-defaults.test.ts → "uses user prefs when workspace is null (no override)" -->
- **WHEN** `resolveModelDefaults({ user: { defaultTextTier: "precise", ... }, workspace: null })`
- **THEN** user values are returned and the override flag is false

#### Scenario: Workspace preferences override user preferences
<!-- test: resolve-model-defaults.test.ts → "workspace values win over user values, the override flag is true" -->
- **WHEN** user has `defaultTextTier = "precise"` and workspace has `defaultTextTier = "fast"`
- **THEN** result returns workspace value "fast" and `overriddenByWorkspace.text = true`

#### Scenario: Explicit text model wins over text tier
<!-- test: resolve-model-defaults.test.ts → "text model beats tier at the user level when both are set" -->
- **WHEN** user has both `defaultTextTier = "fast"` and `defaultTextModel = "anthropic/claude-opus-4.8"`
- **THEN** both are returned in the result; caller prefers model over tier when model is non-null

#### Scenario: Workspace tier overrides user model
<!-- test: resolve-model-defaults.test.ts → "workspace tier overrides user model when workspace has no explicit model" -->
- **WHEN** user has `defaultTextModel = "anthropic/claude-opus-4.8"` and workspace has `defaultTextTier = "balanced"` (no model)
- **THEN** result returns workspace tier "balanced" and user model "anthropic/claude-opus-4.8"; the override flag is true

#### Scenario: There is no media dimension
<!-- test: resolve-model-defaults.test.ts → "resolves text as the only dimension — no image or video model" -->
- **WHEN** any call to `resolveModelDefaults()` returns
- **THEN** the result carries exactly `text` and `overriddenByWorkspace`, and `overriddenByWorkspace` carries exactly `text`

---

### Requirement: Model defaults are loaded from database and resolved

<!-- id: loadEffectiveModelDefaults -->
<!-- entities: User, Workspace, ModelDefaults, Database -->
<!-- enforced: loadEffectiveModelDefaults() -->
<!-- test: load-effective-model-defaults.test.ts → "returns all-null defaults when user has no preferences and no workspace" -->

When a caller invokes `loadEffectiveModelDefaults({ userId, workspaceId })`, the function SHALL query the user's `auth.user_preferences` row and (if workspaceId is provided) the `workspace.workspaces` row, select ONLY the `default_text_tier` / `default_text_model` columns, and delegate to `resolveModelDefaults()` for precedence logic.

#### Scenario: No user preferences, no workspace
<!-- test: load-effective-model-defaults.test.ts → "returns all-null defaults when user has no preferences and no workspace" -->
- **WHEN** `loadEffectiveModelDefaults({ userId: "user-1", workspaceId: null })` and user has no preferences row
- **THEN** all defaults are null and the override flag is false

#### Scenario: User preferences only
<!-- test: load-effective-model-defaults.test.ts → "resolves user preferences when workspace is null" -->
- **WHEN** user has a preferences row with `defaultTextTier = "fast"` and `workspaceId = null`
- **THEN** the user's values are returned; the override flag is false

#### Scenario: Workspace preferences override
<!-- test: load-effective-model-defaults.test.ts → "workspace preferences override user preferences" -->
- **WHEN** both user and workspace have preferences rows set
- **THEN** workspace values win and the override flag is true

#### Scenario: Workspace query is skipped when no workspace context
<!-- test: load-effective-model-defaults.test.ts → "does not query workspaces when workspaceId is null" -->
- **WHEN** `loadEffectiveModelDefaults({ userId: "user-2", workspaceId: null })` is called
- **THEN** the workspace query is never executed; only user preferences are queried

#### Scenario: Only the text columns are selected
<!-- test: load-effective-model-defaults.test.ts → "selects only the text model columns from both tables" -->
- **WHEN** both queries are issued
- **THEN** each `columns` projection is exactly `{ defaultTextTier, defaultTextModel }` — the media columns no longer exist in the schema

---

### Invariant: Model id extraction preserves string or object input

<!-- id: modelIdOf.invariant -->
<!-- entities: LanguageModel -->
<!-- enforced: modelIdOf() -->

The `modelIdOf()` function SHALL always return a non-empty string representing the model id, even if the input is an unusual union shape. If the input is a string, it is returned as-is. If it is an object without a `modelId` property, "unknown" is returned rather than undefined.

---

### Invariant: Model tier defaults are fallback-safe

<!-- id: tier-default-invariant -->
<!-- entities: OxagenTier -->
<!-- enforced: tierModelId() -->

When env var reading returns undefined (e.g., in test environments where mocking omits the var), tier resolution coalesces to a hardcoded default rather than failing, so the selection functions remain callable.

---

### Invariant: Text is the only white-labeled tier dimension

<!-- id: text-only-tier-invariant -->
<!-- entities: OxagenTier -->
<!-- enforced: resolvedTierCatalog(), resolveModelDefaults() -->
<!-- verified_by: catalog.test.ts → "exposes the three text tiers — the only white-labeled tiers left (ADR-043)" -->

`fast` / `balanced` / `precise` are the complete set of Oxagen tiers. There are no image or video tiers, no `OXAGEN_LLM_IMAGE_*` / `OXAGEN_LLM_VIDEO_*` env vars, and no stored media model defaults at either the user or workspace level.

---

### Invariant: Workspace model defaults shadow user preferences

<!-- id: workspace-shadow-invariant -->
<!-- entities: User, Workspace, ModelDefaults -->
<!-- enforced: resolveModelDefaults() -->

When a workspace sets a text model default, that value MUST override the user's preference, even if the user's preference is non-null. The `overriddenByWorkspace.text` flag accurately reports that the workspace set something — not that the workspace won, since a caller preferring `text.model` can still land on the user's model when the workspace set only a tier.

---

### Invariant: Explicit model always wins over tier

<!-- id: model-over-tier-invariant -->
<!-- entities: TextModel -->
<!-- enforced: selectModel(), resolveModelDefaults() -->

When both a model id and a tier are available (via env, selector arg, or database preference), the explicit model id takes precedence over the tier. Callers that receive both `text.model` and `text.tier` from the resolver MUST prefer model when model is non-null.

---

<!-- uncertainty: catalog.ts still carries residual media-generation entries and the supportsImage/supportsVideo/supportsMedia helpers. Nothing in the platform calls them for generation any more (ADR-043 removed every consumer); their removal is a separate catalog cleanup and is deliberately not specified here. -->
