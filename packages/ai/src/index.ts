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
export type { ModelSelector, ImageModelSelector, VideoModelSelector, OxagenTier } from "./models";

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
export { streamAgentReply } from "./stream";
export type { StreamAgentReplyArgs } from "./stream";
export { embedText } from "./embed";
export type { EmbedTextOpts } from "./embed";
export { generateObjectFor } from "./generate-object";
export type { GenerateObjectArgs, GenerateObjectUsage, GenerateObjectResult } from "./generate-object";
export { generateImageFor } from "./generate-image";
export type { GenerateImageForArgs, GenerateImageForResult } from "./generate-image";
export { generateVideoFor } from "./generate-video";
export type { GenerateVideoForArgs, GenerateVideoForResult, VideoModel } from "./generate-video";

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
  conversationTitlePrompt,
  svgGeneratePrompt,
  imageAnalyzePrompt,
  loadWorkspacePromptConfig,
  normalizePromptConfig,
  enhancePromptIfInsufficient,
} from "./prompts";
export type {
  PromptKey,
  OverridablePromptKey,
  PromptConfig,
  SystemPromptContext,
  EnhancePromptArgs,
  EnhancePromptResult,
} from "./prompts";

// Tool descriptor builder — re-exported here so agent domain code doesn't
// import directly from "ai", keeping @oxagen/ai as the single AI SDK chokepoint.
export { tool } from "ai";
export type { Tool, ToolSet } from "ai";
