/**
 * A deterministic engine for the pipeline's own tests.
 *
 * `RunTurnOptions.execute` is required — the pipeline wraps turns, it does not
 * contain one, and the in-process TypeScript loop that used to be its default
 * is deleted. The real engine is Stella, a sidecar; a pipeline test cannot
 * spawn one and should not want to, because what it is testing is evaluate →
 * route → judge → revise, not an engine.
 *
 * So the pipeline's tests inject this: the smallest thing that satisfies the
 * seam's contract while running the caller's scripted `AgentAi` against a real
 * tool set. It exists to keep those tests testing the pipeline. It is NOT a
 * second engine and must not grow into one — it has no retry, no compaction,
 * no loop detection, no budget handling, and no step loop at all. It calls the
 * model once. Anything a test needs beyond that belongs to Stella, and is
 * tested in `@oxagen/agent-runner` against a scripted sidecar.
 *
 * The tools are real: `buildWorkspaceTools` over the caller's workspace, so a
 * script that invokes `edit_file` really edits, the edit-integrity ledger
 * really gates it, and the `file-edit` event the test asserts is emitted by
 * the tool rather than by this file.
 */
import { stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import { buildWorkspaceTools } from "../tools";
import { changedFilesFromDiff } from "../diff";
import {
  DEFAULT_AGENT_MODEL,
  type RunCodingAgentOptions,
  type RunCodingAgentResult,
} from "../types";

/** Cap on a stringified tool input/result carried on a `tool-result` event. */
const EVENT_PAYLOAD_CAP = 2_000;

function capped(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  } catch {
    text = String(value);
  }
  return text.length > EVENT_PAYLOAD_CAP
    ? text.slice(0, EVENT_PAYLOAD_CAP) + "…"
    : text;
}

/**
 * One execution segment: call the scripted model once, let it drive the real
 * tools, and report what changed.
 */
export async function scriptedEngine(
  options: RunCodingAgentOptions,
): Promise<RunCodingAgentResult> {
  const onEvent = options.onEvent ?? ((): void => undefined);
  const tools = options.workspace
    ? buildWorkspaceTools(options.workspace, {
        readOnly: options.readOnly,
        onEvent,
        signal: options.signal,
        fileLock: options.fileLock,
        lockContext: options.lockContext,
        diagnostics: options.diagnostics,
        askUser: options.askUser,
      })
    : {};
  const merged = { ...tools, ...(options.extraTools ?? {}) };
  const wrapped = options.wrapTools ? options.wrapTools(merged) : merged;

  // Attachments ride the instruction message as multimodal content parts —
  // images as `image` parts, videos as AI-SDK `file` parts. Text-only keeps the
  // plain-string shape, which is the common case and every revise round after
  // the first. The pipeline decides WHICH round carries them; reproducing the
  // shape here is what lets it be tested.
  const images = options.images ?? [];
  const videos = options.videos ?? [];
  const instructionMessage: ModelMessage =
    images.length > 0 || videos.length > 0
      ? {
          role: "user",
          content: [
            { type: "text", text: options.instruction },
            ...images.map((img) => ({
              type: "image" as const,
              image: img.data,
              mediaType: img.mediaType,
            })),
            ...videos.map((vid) => ({
              type: "file" as const,
              data: vid.data,
              mediaType: vid.mediaType,
              ...(vid.filename ? { filename: vid.filename } : {}),
            })),
          ],
        }
      : { role: "user", content: options.instruction };
  const messages: ModelMessage[] = [
    ...(options.history ?? []),
    instructionMessage,
  ];

  const stream = options.ai.stream({
    model: options.model ?? DEFAULT_AGENT_MODEL,
    system: options.system ?? "",
    messages,
    tools: wrapped,
    stopWhen: stepCountIs(options.maxSteps ?? 1),
    abortSignal: options.signal,
    effort: options.effort,
    onError: options.onError
      ? (e: { error: unknown }): void =>
          options.onError?.(e.error as Parameters<typeof options.onError>[0])
      : undefined,
  });

  let text = "";
  for await (const part of stream.fullStream as AsyncIterable<
    Record<string, unknown>
  >) {
    const type = part["type"];
    if (type === "text-delta") {
      const delta = String(part["text"] ?? "");
      text += delta;
      onEvent({ type: "text", delta });
    } else if (type === "reasoning-delta") {
      onEvent({ type: "reasoning", delta: String(part["text"] ?? "") });
    } else if (type === "tool-call") {
      onEvent({
        type: "tool-call",
        name: String(part["toolName"] ?? ""),
        input: part["input"],
      });
    } else if (type === "tool-result") {
      onEvent({
        type: "tool-result",
        name: String(part["toolName"] ?? ""),
        input: capped(part["input"]),
        result: capped(part["output"]),
        durationMs: 0,
        ok: true,
      });
    }
  }

  const usage = (await stream.usage) as {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
  };

  const diff = options.workspace ? await options.workspace.diff() : "";
  const changedFiles = changedFilesFromDiff(diff);
  if (options.workspace) onEvent({ type: "final-diff", diff, changedFiles });

  return {
    text,
    steps: 1,
    diff,
    changedFiles,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
    },
    messages: [...messages, { role: "assistant", content: text }],
  };
}
