export * from "./wire-types";
export {
  classifyProviderFailure,
  SidecarHttpError,
  StellaSidecarClient,
} from "./sidecar-transport";
export type {
  DriveTurnHandlers,
  ProviderHandler,
  ReverseRequestFailureMode,
  SidecarClientOptions,
  ToolHandler,
  TurnRunResult,
} from "./sidecar-transport";
export { resolveStellaBinary, readSidecarConfig } from "./stella-binary";
export type { SidecarConfig, StellaBinaryResolution } from "./stella-binary";
