/**
 * @oxagen/functions - Provider-agnostic durable function abstractions.
 *
 * This package defines the contracts that product code depends on. Provider
 * adapters (e.g. @oxagen/inngest-functions) implement these interfaces against
 * their concrete SDK.
 */
export type {
  EventPayload,
  WaitForEventOptions,
  StepContext,
  ConcurrencyConfig,
  CancelOnConfig,
  DurableFunctionConfig,
  DurableFunctionTrigger,
  DurableFunctionHandlerContext,
  DurableFunctionHandler,
  DurableFunction,
  EventClient,
  CreateFunctionFactory,
} from "./types";

export { NonRetriableError } from "./types";
