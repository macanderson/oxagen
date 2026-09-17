import type {
  AssistantContentBlock,
  RenderDirective,
  StreamEvent,
  TurnUsage as ClientTurnUsage,
} from "@/components/chat/stream-event-types";
import { resolveRenderDirective } from "@oxagen/oxagen/capability-meta";
import { meterCreditsForUsage } from "@oxagen/billing";
import {
  partType,
  errorMessageOf,
  formatStreamError,
  type TextDeltaPart,
  type ReasoningDeltaPart,
  type ReasoningBoundaryPart,
  type ToolInputStartPart,
  type ToolInputDeltaPart,
  type ToolCallPart,
  type ToolResultPart,
  type ToolErrorPart,
} from "./stream-parts";

export interface TranslatedTurn {
  /** Full assistant prose, for the `content` column + next turn's history. */
  assistantText: string;
  /** Ordered content blocks (reasoning → tools → text) for refresh re-render. */
  persistedBlocks: AssistantContentBlock[];
}

/** Token usage for the single aggregated `usage` event. */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Prompt-cache read tokens — a subset of `inputTokens` served from cache.
   * Surfaced to the client so the chat UX can show the turn's cache-hit rate. */
  cachedInputTokens?: number;
}

/**
 * Emit the single `usage` StreamEvent for a turn, computing credits charged via
 * the billing meter (best-effort: a pricing-lookup failure omits `creditsCharged`
 * rather than crashing the turn).
 *
 * With the agent-engine step loop this fires ONCE after the loop, from the
 * engine's aggregated `RunCodingAgentResult.usage` — NOT per model step (each
 * step's own `finish` part carries only that step's usage; summing them in the
 * client would show wrong, growing credit numbers). It sits in the same position
 * as before — the last event before persistence and the `[DONE]` sentinel.
 *
 * Returns the client-shape usage it emitted so the caller can persist the SAME
 * numbers (message receipts) — one computation, no way for the live event and
 * the stored receipt to disagree.
 */
export function emitUsageEvent(
  emit: (event: StreamEvent) => void,
  usage: TurnUsage,
  modelId: string,
): ClientTurnUsage {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? 0;
  // Clamp cache reads to [0, inputTokens] — cached tokens are a subset of the
  // prompt, so they can never exceed it (guards against noisy provider counts).
  const cachedTokens = Math.max(
    0,
    Math.min(usage.cachedInputTokens ?? 0, inputTokens),
  );
  let creditsCharged: number | undefined;
  try {
    const credits = meterCreditsForUsage({
      model: modelId,
      inputTokens,
      outputTokens,
    });
    creditsCharged = Number(credits);
  } catch {
    // Pricing lookup failed (e.g. unknown model id) — omit creditsCharged.
  }
  const clientUsage: ClientTurnUsage = {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens,
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
    ...(creditsCharged !== undefined ? { creditsCharged } : {}),
  };
  emit({ type: "usage", usage: clientUsage });
  return clientUsage;
}

/** The stateful translator: consumes one raw part at a time, emits SSE events. */
export interface TurnTranslator {
  /**
   * Feed one raw AI-SDK `fullStream` part. Emits the matching SSE `StreamEvent`s
   * and accumulates ordered content blocks. Safe to call across the engine's
   * per-step `streamText` calls — all accumulator state lives in the closure.
   *
   * Does NOT handle `finish` (usage) or `error` parts — in the engine step loop
   * each step emits its own `finish`, and stream errors are thrown, not streamed;
   * the caller emits ONE aggregated `usage` (via `emitUsageEvent`) after the loop
   * and the single `error` event from its catch. `translateAgentStream` (the
   * single-pass wrapper) re-adds both for its callers.
   */
  onPart(raw: unknown): void;
  /** Finalize: flush trailing prose, drop orphan reasoning blocks, return the turn. */
  finish(): TranslatedTurn;
}

/**
 * Build a stateful translator over an agent reply's `fullStream`. It emits the
 * matching SSE `StreamEvent`s via `emit` and accumulates the ordered assistant
 * content blocks so a page refresh re-renders the exact chain of thought/action
 * — not just final prose.
 *
 * We narrow each part via `partType()` because the SDK's `TextStreamPart<ToolSet>`
 * generic does not produce a concrete discriminated union when TOOLS is the wide
 * `ToolSet` alias (the `tool-result` arm becomes an unresolvable intersection).
 */
export function createTurnTranslator(args: {
  requestId: string;
  toolNameMap: Record<string, string>;
  orgSlug: string;
  workspaceSlug: string;
  emit: (event: StreamEvent) => void;
}): TurnTranslator {
  const { requestId, toolNameMap, orgSlug, workspaceSlug, emit } = args;

  const toolStartedAt: Record<string, number> = {};
  // Accumulate the assistant's text so we can persist the full reply.
  let assistantText = "";

  // ── Ordered content-block accumulator ──────────────────────────────────────
  // `currentText` buffers contiguous text deltas; flushText() commits them as a
  // block whenever a structural event (reasoning/tool/component) interrupts.
  const blocks: AssistantContentBlock[] = [];
  let currentText = "";
  const flushText = (): void => {
    if (currentText.length > 0) {
      blocks.push({ type: "text", text: currentText });
      currentText = "";
    }
  };
  // Index maps so terminal events can update the block pushed earlier. Keyed by
  // the STEP-NAMESPACED reasoning id (see `reasoningKey`) so ids that collide
  // across the engine's per-step `streamText` calls don't clobber each other.
  const reasoningBlockIndex: Record<string, number> = {};
  const reasoningStartedAt: Record<string, number> = {};
  const toolBlockIndex: Record<string, number> = {};
  // toolCallId → real dotted capability name, so the tool-result arm can resolve
  // a render directive for outputs that don't embed one (generic engine).
  const toolCapability: Record<string, string> = {};
  // Multi-step boundary counter (start-step/finish-step).
  let stepIndex = -1;

  // Reasoning ids are generated per `streamText` call, so with the engine's
  // per-step loop `part.id` can REPEAT across steps (a single stream produced
  // unique ids). The client reducer keys reasoning cards by id and resets the
  // card text on `reasoning-start`, so a repeated id would clobber an earlier
  // card. Namespace every reasoning id by the current step so it stays unique
  // across the whole turn (server-side only; the event/block shapes are
  // unchanged — the id is an opaque correlation key the client never parses).
  const reasoningKey = (id: string): string =>
    `s${stepIndex < 0 ? 0 : stepIndex}:${id}`;

  const onPart = (raw: unknown): void => {
    const pType = partType(raw);
    if (pType === "text-delta") {
      const part = raw as TextDeltaPart;
      assistantText += part.text;
      currentText += part.text;
      emit({ type: "text", messageId: requestId, text: part.text });
    } else if (pType === "reasoning-start") {
      const part = raw as ReasoningBoundaryPart;
      const rid = reasoningKey(part.id);
      flushText();
      reasoningStartedAt[rid] = Date.now();
      // Reserve the block slot now so reasoning keeps its place in order.
      reasoningBlockIndex[rid] = blocks.length;
      blocks.push({ type: "reasoning", reasoningId: rid, text: "" });
      emit({ type: "reasoning-start", messageId: requestId, reasoningId: rid });
    } else if (pType === "reasoning-delta") {
      const part = raw as ReasoningDeltaPart;
      const rid = reasoningKey(part.id);
      const idx = reasoningBlockIndex[rid];
      if (idx !== undefined) {
        const blk = blocks[idx];
        if (blk && blk.type === "reasoning") blk.text += part.text;
      }
      emit({ type: "reasoning-delta", reasoningId: rid, text: part.text });
    } else if (pType === "reasoning-end") {
      const part = raw as ReasoningBoundaryPart;
      const rid = reasoningKey(part.id);
      const durationMs =
        reasoningStartedAt[rid] !== undefined
          ? Date.now() - (reasoningStartedAt[rid] as number)
          : 0;
      const idx = reasoningBlockIndex[rid];
      if (idx !== undefined) {
        const blk = blocks[idx];
        if (blk && blk.type === "reasoning") blk.durationMs = durationMs;
      }
      emit({ type: "reasoning-end", reasoningId: rid, durationMs });
    } else if (pType === "start-step") {
      stepIndex += 1;
      flushText();
      emit({ type: "step-start", messageId: requestId, stepIndex });
    } else if (pType === "finish-step") {
      if (stepIndex >= 0) emit({ type: "step-finish", stepIndex });
    } else if (pType === "tool-input-start") {
      const part = raw as ToolInputStartPart;
      flushText();
      emit({
        type: "tool-input-start",
        messageId: requestId,
        toolCallId: part.id,
        capability: toolNameMap[part.toolName] ?? part.toolName,
      });
    } else if (pType === "tool-input-delta") {
      const part = raw as ToolInputDeltaPart;
      emit({
        type: "tool-input-delta",
        toolCallId: part.id,
        delta: part.delta,
      });
    } else if (pType === "tool-call") {
      const part = raw as ToolCallPart;
      toolStartedAt[part.toolCallId] = Date.now();
      // Translate the model-safe tool name back to the real capability name
      // so the UI labels and routes on the real name.
      const capability = toolNameMap[part.toolName] ?? part.toolName;
      toolCapability[part.toolCallId] = capability;
      flushText();
      // Reserve a terminal block; tool-result/tool-error fills it in.
      toolBlockIndex[part.toolCallId] = blocks.length;
      blocks.push({
        type: "tool-call",
        toolCallId: part.toolCallId,
        capability,
        inputPreview: part.input,
        riskLevel: "low",
        status: "running",
      });
      emit({
        type: "tool-call-start",
        messageId: requestId,
        toolCallId: part.toolCallId,
        capability,
        inputPreview: part.input,
        // Default risk level; capabilities may override via tool metadata.
        riskLevel: "low",
      });
    } else if (pType === "tool-result") {
      const part = raw as ToolResultPart;
      // `preliminary` results (streamed partial output) are progress, not
      // completion — the final result for the same call follows. Skip them so a
      // capability that streams partial output never double-emits tool-call-end
      // / component. (The engine's own CodingEvent chain skips these too.)
      if ((raw as { preliminary?: boolean }).preliminary === true) return;
      const durationMs =
        toolStartedAt[part.toolCallId] !== undefined
          ? Date.now() - (toolStartedAt[part.toolCallId] as number)
          : 0;
      // Update the terminal block with the result.
      const idx = toolBlockIndex[part.toolCallId];
      if (idx !== undefined) {
        const blk = blocks[idx];
        if (blk && blk.type === "tool-call") {
          blk.status = "completed";
          blk.output = part.output;
          blk.durationMs = durationMs;
        }
      }
      emit({
        type: "tool-call-end",
        toolCallId: part.toolCallId,
        status: "completed",
        output: part.output,
        durationMs,
      });
      // Render directive resolution (generic capability engine):
      //   1. If the output EMBEDS its own `render` directive (the archive.create
      //      / graph.stats / media pattern — flat, component-specific props),
      //      emit it verbatim with tenant slugs merged in.
      //   2. Otherwise synthesize one via resolveRenderDirective: a bespoke
      //      component for prioritized capabilities, else the generic
      //      `capability-result` card (typed key/value + deep-linked record ids),
      //      so the user NEVER sees a raw-JSON tool result.
      // Either way the client renders CHAT_COMPONENTS[componentId] inline.
      const rawResult = part.output;
      let emittedComponent = false;
      if (
        rawResult !== null &&
        rawResult !== undefined &&
        typeof rawResult === "object"
      ) {
        const render = (rawResult as Record<string, unknown>)["render"] as
          | RenderDirective
          | undefined;
        if (
          render !== undefined &&
          typeof render.componentId === "string" &&
          render.props !== null &&
          typeof render.props === "object"
        ) {
          // Merge org+workspace slugs into render props so that any registry
          // component that needs to call a scoped server action (e.g.
          // make-video-form → videoGenerateAction) has real tenant context.
          const props = {
            ...(render.props as Record<string, unknown>),
            orgSlug,
            workspaceSlug,
          };
          blocks.push({
            type: "component",
            toolCallId: part.toolCallId,
            componentId: render.componentId,
            props,
          });
          emit({
            type: "component",
            toolCallId: part.toolCallId,
            componentId: render.componentId,
            props,
          });
          emittedComponent = true;
        }
      }
      // Generic fallback synthesis. Skip agent.code.execute (it owns a dedicated
      // code-execute block) so we don't double-render the result.
      const capabilityForResult = toolCapability[part.toolCallId];
      if (
        !emittedComponent &&
        capabilityForResult !== undefined &&
        capabilityForResult !== "execute_code"
      ) {
        const directive = resolveRenderDirective({
          capability: capabilityForResult,
          output: rawResult,
          slugs: { orgSlug, workspaceSlug },
        });
        if (directive !== null) {
          blocks.push({
            type: "component",
            toolCallId: part.toolCallId,
            componentId: directive.componentId,
            props: directive.props,
          });
          emit({
            type: "component",
            toolCallId: part.toolCallId,
            componentId: directive.componentId,
            props: directive.props,
          });
        }
      }
    } else if (pType === "tool-error") {
      // A tool whose execute() THREW surfaces as a `tool-error` part (not
      // `tool-result`). Without this arm the client's tool card would spin
      // "running" forever. Emit a failed tool-call-end and mark the block.
      const part = raw as ToolErrorPart;
      const durationMs =
        toolStartedAt[part.toolCallId] !== undefined
          ? Date.now() - (toolStartedAt[part.toolCallId] as number)
          : 0;
      const errorReason = errorMessageOf(part.error);
      const idx = toolBlockIndex[part.toolCallId];
      if (idx !== undefined) {
        const blk = blocks[idx];
        if (blk && blk.type === "tool-call") {
          blk.status = "failed";
          blk.durationMs = durationMs;
          blk.errorReason = errorReason;
        }
      }
      emit({
        type: "tool-call-end",
        toolCallId: part.toolCallId,
        status: "failed",
        errorReason,
        durationMs,
      });
    }
    // finish, error, tool-input-end, start, source, raw, abort — intentionally
    // not handled here (see the interface doc). tool-input-end/source/raw/abort
    // were never forwarded; finish/error are the caller's responsibility.
  };

  const finish = (): TranslatedTurn => {
    // Commit any trailing prose as the final text block.
    flushText();
    // Keep reasoning blocks that actually happened — either they carry summary
    // text (OpenAI/Google) or they completed with a duration (Anthropic adaptive
    // thinking redacts the content but still reports the time spent, which the
    // ReasoningCard renders as a "Thought for Xs" pill). Drop only orphan
    // reasoning-start blocks that never ended.
    const persistedBlocks = blocks.filter(
      (b) =>
        b.type !== "reasoning" ||
        b.text.length > 0 ||
        b.durationMs !== undefined,
    );
    return { assistantText, persistedBlocks };
  };

  return { onPart, finish };
}

/** What the single-pass wrapper returns: the turn, plus the usage it emitted. */
export interface TranslatedTurnWithUsage extends TranslatedTurn {
  /**
   * The client-shape usage emitted from the stream's `finish` part, so the
   * caller can persist the SAME numbers on the message receipt. `null` when the
   * stream carried no `finish` part (an aborted or errored turn) — the caller
   * then emits from the turn's own aggregated usage instead.
   */
  usage: ClientTurnUsage | null;
}

/**
 * Single-pass wrapper: consume a whole `fullStream` into a `createTurnTranslator`
 * and return the accumulated turn. This is what the governed turn loop
 * (`runGovernedTurn` in `@oxagen/agent`) is drained through: the loop hands back
 * the raw AI-SDK stream and this is the only place its parts become the app's
 * SSE wire format. On top of the stateful translator it also handles the
 * `finish` part (→ one `usage` event) and the `error` part (→ structured
 * `error` event). Iterating `fullStream` normally never rejects:
 * provider/gateway failures arrive as an `error` PART, forwarded here as a
 * structured error event rather than letting the turn produce silent zero
 * output. A genuine throw (a client-disconnect abort) propagates to the
 * caller's catch, which is why `translator` can be supplied from outside — the
 * caller keeps a handle on the partial turn and can still persist it.
 */
export async function translateAgentStream(args: {
  fullStream: AsyncIterable<unknown>;
  requestId: string;
  toolNameMap: Record<string, string>;
  orgSlug: string;
  workspaceSlug: string;
  /** Gateway model id (from modelIdOf(turnModel)) used to compute credits charged. */
  modelId: string;
  emit: (event: StreamEvent) => void;
  /**
   * Reuse a translator the caller already built. Pass one when the caller needs
   * to flush a PARTIAL turn from its own catch block after a mid-stream throw;
   * omit it and the wrapper owns a fresh translator for the whole turn.
   */
  translator?: TurnTranslator;
}): Promise<TranslatedTurnWithUsage> {
  const {
    fullStream,
    requestId,
    toolNameMap,
    orgSlug,
    workspaceSlug,
    modelId,
    emit,
  } = args;
  const translator =
    args.translator ??
    createTurnTranslator({
      requestId,
      toolNameMap,
      orgSlug,
      workspaceSlug,
      emit,
    });
  let usage: ClientTurnUsage | null = null;

  for await (const raw of fullStream) {
    const pType = partType(raw);
    if (pType === "finish") {
      const part = raw as {
        totalUsage: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        };
      };
      usage = emitUsageEvent(emit, part.totalUsage, modelId);
    } else if (pType === "error") {
      // Forward a structured `error` event (NOT text) so the client shows a
      // readable toast instead of raw JSON. Never folded into assistantText —
      // persisting it would feed the error into the next turn's history.
      const { code, message } = formatStreamError(
        (raw as { error?: unknown }).error,
      );
      emit({
        type: "error",
        messageId: requestId,
        message,
        ...(code !== undefined ? { code } : {}),
      });
    } else {
      translator.onPart(raw);
    }
  }

  return { ...translator.finish(), usage };
}
