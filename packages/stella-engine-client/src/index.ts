export * from "./wire-types.js";
export { SidecarHttpError, StellaSidecarClient } from "./sidecar-transport.js";
export type {
  DriveTurnHandlers,
  ProviderCallContext,
  ProviderDelta,
  ProviderHandler,
  SidecarClientOptions,
  ToolCallContext,
  ToolHandler,
  TurnRunResult,
} from "./sidecar-transport.js";
export { resolveStellaBinary, readSidecarConfig } from "./stella-binary.js";
export type { SidecarConfig, StellaBinaryResolution } from "./stella-binary.js";
