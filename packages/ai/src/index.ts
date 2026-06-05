export {
  selectModel,
  defaultModel,
  selectImageModel,
  tierModelId,
  imageTierModelId,
  videoTierModelId,
  resolvedTierCatalog,
  DEFAULT_TIER,
} from "./models";
export type { ModelSelector, ProviderName, ImageModelSelector, OxagenTier } from "./models";

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
