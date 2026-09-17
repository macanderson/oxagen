/**
 * What a streaming caller of `ask_assistant` hands the turn beside the
 * contract's input. `POST /chat/stream` invokes the contract through
 * `kernel.invoke()`, so the turn passes the same IAM, audit, rules and billing
 * gates there as on `POST /assistant/ask` and the MCP tool. The parts, the
 * notices, the client's abort and the model and budget overrides are not
 * contract input; they ride in this async context, and the handler takes them
 * once.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AssistantTurnHooks,
  AssistantTurnRequest,
} from "./assistant-turn";

/** The surface's per-turn overrides; the contract's input carries none of them. */
export type AssistantTurnOverrides = Pick<
  AssistantTurnRequest,
  "activeServerIds" | "tier" | "model" | "effort" | "budget"
>;

export interface AssistantStream {
  overrides: AssistantTurnOverrides;
  hooks: AssistantTurnHooks;
  /**
   * The turn passed its refusals (the role gate, the credit gate) and nothing
   * is written yet. A refusal before this is the response itself.
   */
  onPrepared: () => void;
}

const current = new AsyncLocalStorage<{
  stream: AssistantStream;
  taken: boolean;
}>();

/** Run `invokeTurn` (the `ask_assistant` invoke) with `stream` beside it. */
export function streamAssistantTurn<T>(
  stream: AssistantStream,
  invokeTurn: () => Promise<T>,
): Promise<T> {
  return current.run({ stream, taken: false }, invokeTurn);
}

/**
 * The stream the enclosing `streamAssistantTurn` carries, or null. The first
 * caller takes it, so an invoke nested inside the turn never sees it.
 */
export function takeAssistantStream(): AssistantStream | null {
  const slot = current.getStore();
  if (!slot || slot.taken) return null;
  slot.taken = true;
  return slot.stream;
}
