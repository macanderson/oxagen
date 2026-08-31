export * from "./wire-types.js";
export {
  classifyProviderFailure,
  SidecarHttpError,
  StellaSidecarClient,
} from "./sidecar-transport.js";
export type {
  DriveTurnHandlers,
  ProviderHandler,
  ReverseRequestFailureMode,
  SidecarClientOptions,
  ToolHandler,
  TurnRunResult,
} from "./sidecar-transport.js";
export { resolveStellaBinary, readSidecarConfig } from "./stella-binary.js";
export type { SidecarConfig, StellaBinaryResolution } from "./stella-binary.js";
