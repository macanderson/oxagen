import type {
  AssistantContentBlock,
  BackgroundTaskStatus,
  PlanStep,
  RenderDirective,
  StreamEvent,
  SubagentChild,
} from "@/components/chat/stream-event-types";
import { resolveRenderDirective } from "@oxagen/oxagen/capability-meta";
import { tokenUsageCreditsCeiling } from "@oxagen/billing";
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
  /**
   * Turn usage observed from the SDK's `finish` part. Persisted under the
   * assistant message's `metadata.usage` so the message footer can show the
   * same credits + tokens after a refresh. `undefined` if the turn ended
   * before any LLM call produced usage (e.g. a tool-side error).
   */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; creditsCharged: number };
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
  /**
   * Resolved gateway model id for this turn (e.g. "anthropic/claude-sonnet-4.6").
   * Used to price the SSE `usage` event's `creditsCharged` field — display only;
   * the authoritative debit happens inside `streamAgentReply`'s `onFinish` via
   * the billing gate.
   */
  modelId: string;
  /** Solved meter markup (cached) — see {@link tokenUsageCreditsCeiling}. */
  meterMarkup: number;
}): Promise<TranslatedTurn> {
  const { fullStream, requestId, toolNameMap, orgSlug, workspaceSlug, emit, modelId, meterMarkup } = args;

  const toolStartedAt: Record<string, number> = {};
  // Accumulate the assistant's text so we can persist the full reply.
  let assistantText = "";
  // Captured here so we can return it to the route for metadata persistence.
  let finalUsage: TranslatedTurn["usage"] = undefined;

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
      // High-level capability → stream-event translation. Certain capability
      // tool calls carry semantic meaning (a plan was proposed, a fanout was
      // dispatched, a memory was written, a background task was started). We
      // emit a typed event for each so the chat UI renders the matching live
      // card (PlanCard/SubagentFanout/MemoryCard/BackgroundTaskCard) — without
      // these, those cards only appear after a refresh from persisted blocks.
      const capForTranslate = toolCapability[part.toolCallId];
      if (capForTranslate !== undefined) {
        const out = isRecord(part.output) ? part.output : null;
        if (out !== null) {
          if (capForTranslate === "agent.plan.create") {
            const planId = typeof out.planId === "string" ? out.planId : null;
            const tasksRaw = Array.isArray(out.tasks) ? out.tasks : [];
            const goalsRaw = Array.isArray(out.goals) ? out.goals : [];
            if (planId !== null) {
              const steps: PlanStep[] = tasksRaw.map((t) => {
                const r = isRecord(t) ? t : {};
                return {
                  id: typeof r.id === "string" ? r.id : "",
                  summary: typeof r.title === "string" ? r.title : "",
                  intent: typeof r.description === "string" ? r.description : "",
                  capability: typeof r.capability === "string" ? r.capability : null,
                  dependsOn: Array.isArray(r.dependsOn)
                    ? r.dependsOn.filter((d): d is string => typeof d === "string")
                    : [],
                };
              });
              const title = goalsRaw.find((g): g is string => typeof g === "string") ?? "Proposed plan";
              blocks.push({
                type: "plan",
                planId,
                title,
                steps,
                status: "pending",
              });
              emit({
                type: "plan-proposed",
                planId,
                title,
                steps,
              });
            }
          } else if (capForTranslate === "agent.subagent.dispatch") {
            const dispatchId = typeof out.dispatchId === "string" ? out.dispatchId : null;
            if (dispatchId !== null) {
              // The dispatch result carries totalTasks but not the per-child
              // capability list; we read it back from the tool input preview
              // (the agent passed the tasks array in).
              const tasksFromInput = (() => {
                const blk = blocks[idx ?? -1];
                if (!blk || blk.type !== "tool-call") return [];
                const ip = blk.inputPreview;
                if (!isRecord(ip) || !Array.isArray(ip.tasks)) return [];
                return ip.tasks;
              })();
              const children: SubagentChild[] = tasksFromInput.map((t, ci) => {
                const r = isRecord(t) ? t : {};
                return {
                  childMessageId: `${dispatchId}:${ci}`,
                  capability: typeof r.capabilityName === "string" ? r.capabilityName : "agent.compose",
                  status: "running" as const,
                };
              });
              blocks.push({
                type: "subagent-fanout",
                fanoutId: dispatchId,
                parentMessageId: requestId,
                children,
                status: "running",
              });
              emit({
                type: "subagent-dispatched",
                fanoutId: dispatchId,
                parentMessageId: requestId,
                children: children.map((c) => ({
                  childMessageId: c.childMessageId,
                  capability: c.capability,
                  ...(c.label !== undefined ? { label: c.label } : {}),
                })),
              });
            }
          } else if (capForTranslate === "agent.memory.write") {
            const memoryId = typeof out.memoryId === "string" ? out.memoryId : null;
            const nodeRef = typeof out.nodeRef === "string" ? out.nodeRef : null;
            if (memoryId !== null && nodeRef !== null) {
              // Pull weight from the recorded tool input preview when present.
              const weight = (() => {
                const blk = blocks[idx ?? -1];
                if (!blk || blk.type !== "tool-call") return "consider";
                const ip = blk.inputPreview;
                if (!isRecord(ip) || typeof ip.weight !== "string") return "consider";
                return ip.weight;
              })();
              emit({
                type: "memory-written",
                memoryId,
                nodeRef,
                weight,
              });
            }
          } else if (capForTranslate === "agent.memory.recall") {
            const memoriesRaw = Array.isArray(out.memories) ? out.memories : [];
            if (memoriesRaw.length > 0) {
              const memories = memoriesRaw
                .map((m) => (isRecord(m) ? m : null))
                .filter((m): m is Record<string, unknown> => m !== null)
                .map((m) => ({
                  id: typeof m.id === "string" ? m.id : "",
                  lesson: typeof m.lesson === "string" ? m.lesson : "",
                  weight: typeof m.weight === "string" ? m.weight : "consider",
                  score: typeof m.score === "number" ? m.score : 0,
                  ...(typeof m.nodeRef === "string" ? { nodeRef: m.nodeRef } : {}),
                }));
              const queryId = part.toolCallId;
              blocks.push({ type: "memory-recall", queryId, memories });
              emit({ type: "memory-recalled", queryId, memories });
            }
          } else if (capForTranslate === "agent.task.background.start") {
            const taskId = typeof out.taskId === "string" ? out.taskId : null;
            const inngestRunId = typeof out.inngestRunId === "string" ? out.inngestRunId : undefined;
            if (taskId !== null) {
              const kindLabel = (() => {
                const blk = blocks[idx ?? -1];
                if (!blk || blk.type !== "tool-call") return { kind: "agent.task", label: undefined };
                const ip = blk.inputPreview;
                if (!isRecord(ip)) return { kind: "agent.task", label: undefined };
                return {
                  kind: typeof ip.kind === "string" ? ip.kind : "agent.task",
                  label: typeof ip.label === "string" ? ip.label : undefined,
                };
              })();
              const status: BackgroundTaskStatus = "queued";
              blocks.push({
                type: "background-task",
                taskId,
                kind: kindLabel.kind,
                ...(kindLabel.label !== undefined ? { label: kindLabel.label } : {}),
                status,
                ...(inngestRunId !== undefined ? { inngestRunId } : {}),
              });
              emit({
                type: "background-task-progress",
                taskId,
                kind: kindLabel.kind,
                ...(kindLabel.label !== undefined ? { label: kindLabel.label } : {}),
                status,
                ...(inngestRunId !== undefined ? { inngestRunId } : {}),
              });
            }
          }
        }
      }
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
      const inputTokens = part.totalUsage.inputTokens ?? 0;
      const outputTokens = part.totalUsage.outputTokens ?? 0;
      const totalTokens = part.totalUsage.totalTokens ?? 0;
      // Credits priced from the same rate card + meter markup the gate uses.
      // Display-only: the authoritative debit happens inside streamAgentReply's
      // onFinish via the billing gate. We just mirror the math so the chat UI
      // can show "X credits · Y tokens" inline below the assistant message.
      // Zero-usage turns (errors before any LLM call) get creditsCharged === 0
      // and the footer suppresses the display per the acceptance criteria.
      const creditsCharged =
        totalTokens > 0
          ? tokenUsageCreditsCeiling({ model: modelId, inputTokens, outputTokens }, meterMarkup)
          : 0;
      finalUsage = {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens,
        creditsCharged,
      };
      emit({
        type: "usage",
        usage: finalUsage,
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

  return {
    assistantText,
    persistedBlocks,
    ...(finalUsage !== undefined ? { usage: finalUsage } : {}),
  };
}
