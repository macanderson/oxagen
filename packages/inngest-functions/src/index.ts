export { inngest } from "./inngest";
export type { InngestClient } from "./inngest";
export { functions } from "./functions";
export { logger } from "./logger";
export {
  inngestEnvironmentComplaint,
  signingKeyPosture,
} from "./env-check";
export type { InngestKeyPosture } from "./env-check";

// ─── Provider-agnostic adapter & types ───────────────────────────────────────
export {
  createEventClient,
  NonRetriableError,
  createFunction,
} from "./adapter";
export type { EventClient } from "./adapter";
export type {
  EventPayload,
  StepContext,
  DurableFunctionConfig,
  DurableFunctionTrigger,
  DurableFunction,
  CreateFunctionFactory,
} from "@oxagen/functions";
