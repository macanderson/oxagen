export {
  selectModel,
  defaultModel,
  selectImageModel,
  selectVideoModel,
  tierModelId,
  imageTierModelId,
  videoTierModelId,
  resolvedTierCatalog,
  modelIdOf,
  DEFAULT_TIER,
} from "./models";
export type {
  ModelSelector,
  ImageModelSelector,
  VideoModelSelector,
  OxagenTier,
} from "./models";

// Re-export the client-safe catalog from the package root for server callers
// (route guards, RSC). Client components should import from "@oxagen/ai/catalog"
// directly to avoid pulling the provider SDKs into the browser bundle.
export {
  gatewayModels,
  vendorLabels,
  getModel,
  supportsReasoning,
  supportsImage,
  supportsVideo,
  supportsVision,
  supportsVideoInput,
  supportsText,
  supportsMedia,
  capabilityLabel,
  formatReleaseDate,
  TEXT_TIERS,
  MEDIA_TIERS,
} from "./catalog";
export type {
  Capability,
  Vendor,
  EffortLevel,
  MediaKind,
  TextTier,
  MediaTier,
  GatewayModel,
  ResolvedTierCatalog,
} from "./catalog";

// Provider capability posture registry — the per-vendor feature matrix
// (cache / reasoning / structured output / attachments). Client-safe, like the
// catalog: client components should import "@oxagen/ai/posture" directly so the
// provider SDKs stay out of the browser bundle.
export {
  CACHE_POSTURE,
  REASONING_POSTURE,
  STRUCTURED_OUTPUT_POSTURE,
  ATTACHMENT_POSTURE,
  WITNESS_SOURCES,
  allPostures,
  asVendor,
  postureBadges,
  postureForModel,
  posturesFor,
  vendorFromModelId,
} from "./provider-posture";
export type {
  AttachmentPosture,
  CachePosture,
  PostureBadge,
  ReasoningPosture,
  StructuredOutputPosture,
  VendorPosture,
} from "./provider-posture";

export { streamAgentReply } from "./stream";
export type { StreamAgentReplyArgs } from "./stream";
export { embedText } from "./embed";
export type { EmbedTextOpts } from "./embed";

// Response cache — opt-in layered (exact + semantic) cache for deterministic
// background inference. See ./cache; wired into generateObjectFor via `cache`.
export {
  readCache,
  writeCache,
  buildCacheKey,
  cosineSimilarity,
  sha256Hex,
} from "./cache";
export type {
  CacheOptions,
  CacheContext,
  CacheReadResult,
  CachedUsage,
  CachedResponseKind,
} from "./cache";

// Message Batches — background inference at half price (direct Anthropic).
export { submitBatch, pollBatch } from "./batch";
export type {
  BatchRequestInput,
  BatchTelemetry,
  SubmitBatchArgs,
  SubmitBatchResult,
  PollBatchArgs,
  PollBatchResult,
  BatchResultItem,
} from "./batch";

export { generateObjectFor } from "./generate-object";
export type {
  GenerateObjectArgs,
  GenerateObjectUsage,
  GenerateObjectResult,
} from "./generate-object";
export { generateImageFor } from "./generate-image";
export type {
  GenerateImageForArgs,
  GenerateImageForResult,
} from "./generate-image";
export {
  generateVideoFor,
  supportedVideoDurations,
  resolveVideoDurationSeconds,
  videoDurationAlternatives,
} from "./generate-video";
export type {
  GenerateVideoForArgs,
  GenerateVideoForResult,
  VideoModel,
  ResolvedVideoDuration,
  VideoDurationAlternative,
} from "./generate-video";

// Model-default resolver (client-safe, also re-exported from @oxagen/ai/catalog).
export { resolveModelDefaults } from "./resolve-model-defaults";
export type {
  ModelTier,
  ModelDefaultsInput,
  ResolvedModelDefaults,
} from "./resolve-model-defaults";

// Server-only: loads effective model defaults from DB for a user+workspace session.
export { loadEffectiveModelDefaults } from "./load-effective-model-defaults";
export type { LoadEffectiveModelDefaultsArgs } from "./load-effective-model-defaults";

// Prompt registry: baseline system prompts + tiered customer-override resolution.
export {
  resolvePrompt,
  isOverridablePromptKey,
  OVERRIDABLE_PROMPT_KEYS,
  chatSystemPrompt,
  codeModeSystemPrompt,
  conversationTitlePrompt,
  svgGeneratePrompt,
  imageAnalyzePrompt,
  loadWorkspacePromptConfig,
  loadWorkspacePromptConfigSafe,
  normalizePromptConfig,
  enhancePromptIfInsufficient,
  SLASH_COMMANDS,
  matchSlashCommands,
  slashCommandsPromptSection,
} from "./prompts";
export type {
  PromptKey,
  OverridablePromptKey,
  PromptConfig,
  SystemPromptContext,
  SkillIndexEntry,
  EnhancePromptArgs,
  EnhancePromptResult,
  SlashCommand,
} from "./prompts";

// Tool descriptor builder, JSON-Schema tool input helper, and core message
// types — re-exported here so agent domain code doesn't import directly from
// "ai", keeping @oxagen/ai as the single AI SDK chokepoint. `jsonSchema` builds
// a tool input schema from a raw JSON Schema (used by the OpenAI-compatible CLI
// proxy, where tool params arrive as JSON Schema rather than Zod).
// `stepCountIs` builds the `stopWhen` predicate that bounds a multi-step
// agentic tool loop. Callers with tools MUST pass one — the AI SDK default is
// `stepCountIs(1)`, which halts the turn after the first step, so a tool call
// executes but the model never gets a second step to read the result and reply.
export { tool, jsonSchema, stepCountIs } from "ai";
export type { Tool, ToolSet, ModelMessage } from "ai";
export type { JSONSchema7 } from "@ai-sdk/provider";
