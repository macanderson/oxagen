/**
 * Public surface of the model-runtime layer.
 *
 * The on-device coordinator, the device/registry/resolver helpers, and the
 * model provisioning (download + optional runtime) live behind this barrel.
 * Cloud completions are not served here — those go through `@oxagen/ai`'s
 * gateway (metered), so this layer is on-device inference plus the shared
 * registry vocabulary the CLI's `models` command reads.
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
  AutoDownloadDisabledError,
  NoFittingModelError,
  ON_DEVICE_ID,
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
