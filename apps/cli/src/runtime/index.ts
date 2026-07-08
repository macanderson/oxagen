/**
 * Public surface of the model-runtime layer (Group 1).
 *
 * Group 2's orchestrator imports from here to run the coordinator on device and
 * dispatch workers to cloud models through one interface. Keep this surface
 * stable — later groups depend on it.
 */
export type {
  CapabilityRow,
  CloudModelEntry,
  CompletionMessage,
  CompletionRequest,
  CompletionResult,
  CompletionUsage,
  DeviceProfile,
  ModelCapabilities,
  ModelKind,
  ModelProvider,
  ModelSource,
  Quantization,
  ReasoningEffort,
  RegistryFile,
  RuntimeConfigDefaults,
} from "./types.js";

export {
  buildProvider,
  coordinatorProvider,
  judgeProvider,
  workerProvider,
  ON_DEVICE_ID,
  type BuildDeps,
} from "./providers/factory.js";

export {
  AnthropicProvider,
  GatewayCloudProvider,
  MissingCredentialError,
  OfflineError,
  OpenAiProvider,
  type CloudProviderDeps,
  type GenerateFn,
} from "./providers/cloud.js";

export {
  AutoDownloadDisabledError,
  NoFittingModelError,
  OnDeviceProvider,
  OptionalDepMissingError,
  type OnDeviceProviderDeps,
} from "./providers/on-device.js";

export {
  detectDevice,
  estimateModelRamGB,
  fitsDevice,
  memoryBudgetGB,
  paramsBillions,
} from "./device.js";

export {
  bestFittingQuant,
  resolveBestOnDeviceModel,
  type ResolvedOnDevice,
  type ResolveResult,
  type UnresolvedOnDevice,
} from "./resolver.js";

export {
  capabilityRow,
  capabilityTable,
  cloudModel,
  cloudModelIds,
  expandHome,
  loadRegistry,
  registryDefaults,
  roles,
} from "./registry.js";

export {
  getAutoDownload,
  getCacheDir,
  getCoordinator,
  getOnDeviceModelId,
  getQuantizationPreference,
  getVerifyChecksum,
  setCoordinator,
  setOnDeviceConfig,
} from "./config.js";

export {
  cacheDir,
  cachedPath,
  ChecksumMismatchError,
  ensureModelCached,
  isCached,
  manifestEntry,
  readManifest,
  verifyIntegrity,
  type CacheEntry,
  type CacheStatus,
  type FetchImpl,
  type ProgressFn,
} from "./provisioning/download.js";

export {
  isOptionalDepInstalled,
  loadOptionalRuntime,
  OPTIONAL_DEP,
  type LoadedModel,
  type OnDeviceRuntime,
} from "./provisioning/optional-runtime.js";

export { estimateInputTokens, estimateTokens } from "./tokens.js";
