import type {
  AssistantContentBlock,
  RenderDirective,
  StreamEvent,
} from "@/components/chat/stream-event-types";
import { resolveRenderDirective } from "@oxagen/oxagen/capability-meta";
import {
  partType,
  isRecord,
  errorMessageOf,
  type TextDeltaPart,
  type ReasoningDeltaPart,
  type ReasoningBoundaryPart,
  type ToolInputStartPart,
  type ToolInputDeltaPart,
  type ToolCallPart,
  type ToolResultPart,
  type ToolErrorPart,
  type FinishPart,
} from "./stream-parts";

export interface TranslatedTurn {
  /** Full assistant prose, for the `content` column + next turn's history. */
  assistantText: string;
  /** Ordered content blocks (reasoning → tools → text) for refresh re-render. */
  persistedBlocks: AssistantContentBlock[];
}

/**
 * Consume an agent reply's `fullStream`, emit the matching SSE `StreamEvent`s
 * via `emit`, and accumulate the ordered assistant content blocks so a page
 * refresh re-renders the exact chain of thought/action — not just final prose.
 *
 * We iterate as `AsyncIterable<unknown>` and narrow with `partType()` because
 * the SDK's `TextStreamPart<ToolSet>` generic does not produce a concrete
 * discriminated union when TOOLS is the wide `ToolSet` alias (the `tool-result`
 * arm becomes an unresolvable intersection).
 *
 * Iterating `fullStream` never rejects: provider/gateway failures arrive as an
 * `error` PART, which we forward as a visible text event rather than letting the
 * turn produce silent zero output.
 */
export async function translateAgentStream(args: {
  fullStream: AsyncIterable<unknown>;
  requestId: string;
  toolNameMap: Record<string, string>;
  orgSlug: string;
  workspaceSlug: string;
  emit: (event: StreamEvent) => void;
}): Promise<TranslatedTurn> {
  const { fullStream, requestId, toolNameMap, orgSlug, workspaceSlug, emit } = args;

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
  // Index maps so terminal events can update the block pushed earlier.
  const reasoningBlockIndex: Record<string, number> = {};
  const reasoningStartedAt: Record<string, number> = {};
  const toolBlockIndex: Record<string, number> = {};
  // toolCallId → real dotted capability name, so the tool-result arm can resolve
  // a render directive for outputs that don't embed one (generic engine).
  const toolCapability: Record<string, string> = {};
  // Multi-step boundary counter (start-step/finish-step).
  let stepIndex = -1;

  for await (const raw of fullStream) {
    const pType = partType(raw);
    if (pType === "text-delta") {
      const part = raw as TextDeltaPart;
      assistantText += part.text;
      currentText += part.text;
      emit({ type: "text", messageId: requestId, text: part.text });
    } else if (pType === "reasoning-start") {
      const part = raw as ReasoningBoundaryPart;
      flushText();
      reasoningStartedAt[part.id] = Date.now();
      // Reserve the block slot now so reasoning keeps its place in order.
      reasoningBlockIndex[part.id] = blocks.length;
      blocks.push({ type: "reasoning", reasoningId: part.id, text: "" });
      emit({ type: "reasoning-start", messageId: requestId, reasoningId: part.id });
    } else if (pType === "reasoning-delta") {
      const part = raw as ReasoningDeltaPart;
      const idx = reasoningBlockIndex[part.id];
      if (idx !== undefined) {
        const blk = blocks[idx];
        if (blk && blk.type === "reasoning") blk.text += part.text;
      }
      emit({ type: "reasoning-delta", reasoningId: part.id, text: part.text });
    } else if (pType === "reasoning-end") {
      const part = raw as ReasoningBoundaryPart;
      const durationMs =
        reasoningStartedAt[part.id] !== undefined
          ? Date.now() - (reasoningStartedAt[part.id] as number)
          : 0;
      const idx = reasoningBlockIndex[part.id];
      if (idx !== undefined) {
        const blk = blocks[idx];
        if (blk && blk.type === "reasoning") blk.durationMs = durationMs;
      }
      emit({ type: "reasoning-end", reasoningId: part.id, durationMs });
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
      emit({ type: "tool-input-delta", toolCallId: part.id, delta: part.delta });
    } else if (pType === "tool-call") {
      const part = raw as ToolCallPart;
      toolStartedAt[part.toolCallId] = Date.now();
      // Translate the model-safe tool name back to the real dotted capability
      // name so the UI labels and routes (e.g. agent.code.execute →
      // CodeExecuteCard) on the real name.
      const capability = toolNameMap[part.toolName] ?? part.toolName;
      toolCapability[part.toolCallId] = capability;
      flushText();
      // Reserve a terminal block; tool-result/tool-error fills it in.
      toolBlockIndex[part.toolCallId] = blocks.length;
      if (capability === "agent.code.execute") {
        const inp = isRecord(part.input) ? part.input : {};
        blocks.push({
          type: "code-execute",
          toolCallId: part.toolCallId,
          language: typeof inp.language === "string" ? inp.language : "node",
          code: typeof inp.code === "string" ? inp.code : "",
          status: "running",
        });
      } else {
        blocks.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          capability,
          inputPreview: part.input,
          riskLevel: "low",
          status: "running",
        });
      }
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
        } else if (blk && blk.type === "code-execute") {
          const out = isRecord(part.output) ? part.output : {};
          blk.status = "completed";
          if (typeof out.stdout === "string") blk.stdout = out.stdout;
          if (typeof out.stderr === "string") blk.stderr = out.stderr;
          if (typeof out.exitCode === "number") blk.exitCode = out.exitCode;
          if (typeof out.oomKilled === "boolean") blk.oomKilled = out.oomKilled;
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
      if (rawResult !== null && rawResult !== undefined && typeof rawResult === "object") {
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
        capabilityForResult !== "agent.code.execute"
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
        if (blk && (blk.type === "tool-call" || blk.type === "code-execute")) {
          blk.status = "failed";
          blk.durationMs = durationMs;
          if (blk.type === "tool-call") blk.errorReason = errorReason;
          else blk.stderr = (blk.stderr ?? "") + errorReason;
        }
      }
      emit({
        type: "tool-call-end",
        toolCallId: part.toolCallId,
        status: "failed",
        errorReason,
        durationMs,
      });
    } else if (pType === "finish") {
      const part = raw as FinishPart;
      // Emit usage so the client can show credits consumed this turn.
      emit({
        type: "usage",
        usage: {
          promptTokens: part.totalUsage.inputTokens ?? 0,
          completionTokens: part.totalUsage.outputTokens ?? 0,
          totalTokens: part.totalUsage.totalTokens ?? 0,
        },
      });
    } else if (pType === "error") {
      // streamText surfaces provider/gateway failures (e.g. a 400 from a bad
      // request, auth, or rate limit) as an `error` PART rather than throwing.
      // If we don't forward it the turn produces zero output and the user sees
      // nothing. Surface it as a text event (same shape the outer catch uses).
      const errVal = (raw as { error?: unknown }).error;
      const message =
        errVal instanceof Error
          ? errVal.message
          : typeof errVal === "string"
            ? errVal
            : "Stream error";
      // Show the failure live but do NOT fold it into assistantText — persisting
      // "[Error: …]" as the assistant reply would feed the error back into the
      // next turn's history context.
      emit({ type: "text", messageId: requestId, text: `\n\n[Error: ${message}]` });
    }
    // tool-input-end, source, raw, abort — intentionally not forwarded.
  }

  // Commit any trailing prose as the final text block.
  flushText();
  // Keep reasoning blocks that actually happened — either they carry summary
  // text (OpenAI/Google) or they completed with a duration (Anthropic adaptive
  // thinking redacts the content but still reports the time spent, which the
  // ReasoningCard renders as a "Thought for Xs" pill). Drop only orphan
  // reasoning-start blocks that never ended.
  const persistedBlocks = blocks.filter(
    (b) => b.type !== "reasoning" || b.text.length > 0 || b.durationMs !== undefined,
  );

  return { assistantText, persistedBlocks };
}
