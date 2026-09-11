/**
 * `@oxagen/stella-engine-client` — the host side of Stella's headless engine.
 *
 * `stella-serve` runs the agent loop and nothing else: it asks the host for
 * every model completion and every tool call over an event stream, and the
 * host answers on three POST routes. This package is that conversation,
 * typed against the wire Stella publishes (`./wire`), with a transport
 * (`./client`), a loop that runs one turn to its outcome (`./drive-turn`),
 * and the SSE decoder between them (`./sse`).
 *
 * It depends on `fetch` and nothing else, so it stays trivial to keep in step
 * with the server: `STELLA_SERVE_PINNED_VERSION` names the release the wire
 * types were copied from and the smoke test drove.
 */

export {
  EngineHttpError,
  StellaEngineClient,
  isAbortError,
  isStaleRequest,
} from "./client";
export type { OpenFramesOptions, StellaEngineClientOptions } from "./client";

export {
  DEFAULT_RESUME_POLICY,
  TurnStreamLostError,
  classifyProviderError,
  classifyToolError,
  driveTurn,
  resumeAfter,
} from "./drive-turn";
export type {
  DriveTurnHandlers,
  DriveTurnOptions,
  ProviderRequestContext,
  ProviderRequestHandler,
  ProviderRequestView,
  RequestContext,
  RequeryRequestHandler,
  ResumePolicy,
  ToolRequestHandler,
  ToolRequestView,
  TurnDriveResult,
  TurnHold,
} from "./drive-turn";

export { SseDecoder, decodeSseStream, frameSeq, recordToFrame } from "./sse";
export type { SseRecord } from "./sse";

export { STELLA_SERVE_PINNED_VERSION } from "./version";

export type * from "./wire";
