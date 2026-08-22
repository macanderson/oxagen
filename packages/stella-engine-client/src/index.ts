export * from "./wire-types";
export { SidecarHttpError, StellaSidecarClient } from "./sidecar-transport";
export type {
  DriveTurnHandlers,
  ProviderCallContext,
  ProviderDelta,
  ProviderHandler,
  SidecarClientOptions,
  ToolCallContext,
  ToolHandler,
  TurnRunResult,
} from "./sidecar-transport";
export { resolveStellaBinary, readSidecarConfig } from "./stella-binary";
export type { SidecarConfig, StellaBinaryResolution } from "./stella-binary";
