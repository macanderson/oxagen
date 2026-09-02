/**
 * An AI-SDK `LanguageModelV3` that drives the local GGUF coordinator.
 *
 * The on-device runtime ({@link OnDeviceProvider}) only knows how to turn a list
 * of chat messages into a single completion string — it has no native tool /
 * function calling and no token streaming. The agent loop, however, speaks the
 * AI SDK's `streamText`/`generateObject` protocol, which needs a model that
 * emits structured tool-call parts and a stream. This adapter is the bridge:
 *
 *   1. It flattens the SDK's structured `LanguageModelV3Prompt` (system / user /
 *      assistant / tool messages, including prior tool calls + results) back into
 *      the flat `CompletionMessage[]` the runtime understands.
 *   2. It teaches the local model to call tools by describing them in the system
 *      prompt and asking it to emit a fenced ```json {"tool_call": …} block. The
 *      model's raw text is then parsed back into AI-SDK `tool-call` content, so
 *      the SDK's own tool loop runs unchanged.
 *   3. `doStream` replays a completed generation as a minimal, spec-correct part
 *      stream (the runtime is single-shot, so there is nothing finer to stream).
 *
 * Tool-calling on small local models is best-effort — the parser is deliberately
 * lenient (fenced block, bare object, or `tool_call`/`name`+`arguments` shapes).
 * The pure helpers (`renderToolInstructions`, `flattenPrompt`, `parseModelText`)
 * are exported for unit tests so the shim's contract is pinned without weights.
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type {
  CompletionMessage,
  CompletionUsage,
  ReasoningEffort,
} from "../types.js";

/** Render one tool-result output part into the flat text the local model reads. */
function renderToolOutput(output: LanguageModelV3ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "execution-denied":
      return `execution denied${output.reason ? `: ${output.reason}` : ""}`;
    default:
      // 'content' (multi-part) and any future variant — serialise structurally.
      return JSON.stringify(output);
  }
}

/** The single-shot completion seam this model is built on (backed by the GGUF runtime). */
export interface OnDeviceComplete {
  (req: {
    messages: CompletionMessage[];
    maxOutputTokens?: number;
    temperature?: number;
    effort?: ReasoningEffort;
    signal?: AbortSignal;
  }): Promise<{ text: string; usage: CompletionUsage }>;
}

export interface OnDeviceLanguageModelDeps {
  /** Concrete resolved model id, surfaced as `modelId` for logging. */
  modelId: string;
  /** The completion function (defaults come from {@link OnDeviceProvider.complete}). */
  complete: OnDeviceComplete;
  /** Injectable tool-call id generator (kept deterministic-friendly for tests). */
  generateId?: () => string;
}

/** A tool call parsed out of the local model's free-text output. */
export interface ParsedToolCall {
  name: string;
  /** Stringified JSON arguments (the shape the SDK's `tool-call.input` wants). */
  input: string;
}

/** The parse of one model completion: leading prose plus any tool calls it emitted. */
export interface ParsedModelText {
  text: string;
  toolCalls: ParsedToolCall[];
}

// ── Prompt rendering ─────────────────────────────────────────────────────────

/**
 * Describe the available tools to a model with no native function-calling. We
 * list each tool's name, description, and JSON schema, then pin the exact reply
 * convention the parser looks for. Returns "" when the turn exposes no tools.
 */
export function renderToolInstructions(
  tools: LanguageModelV3CallOptions["tools"],
): string {
  const fns = (tools ?? []).filter(
    (t): t is LanguageModelV3FunctionTool => t.type === "function",
  );
  if (fns.length === 0) return "";

  const lines = fns.map((t) => {
    const schema = JSON.stringify(t.inputSchema ?? {});
    const desc = t.description ? ` — ${t.description}` : "";
    return `- ${t.name}${desc}\n  input JSON schema: ${schema}`;
  });

  return [
    "You can call tools. The available tools are:",
    lines.join("\n"),
    "",
    "To call a tool, reply with ONLY a fenced code block of the form:",
    "```json",
    '{ "tool_call": { "name": "<tool name>", "arguments": { /* matching the schema */ } } }',
    "```",
    "Emit one block per tool call. When you have the final answer for the user,",
    "reply in plain text with no code block.",
  ].join("\n");
}

/** Render a JSON-schema response-format instruction for `generateObject`. */
export function renderJsonInstructions(
  responseFormat: LanguageModelV3CallOptions["responseFormat"],
): string {
  if (!responseFormat || responseFormat.type !== "json") return "";
  const schema = responseFormat.schema
    ? JSON.stringify(responseFormat.schema)
    : "";
  return [
    "Respond with ONLY a single JSON object and nothing else — no prose, no code fence.",
    schema ? `The object MUST conform to this JSON schema: ${schema}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Flatten the SDK's structured prompt into the flat `CompletionMessage[]` the
 * runtime consumes. Assistant tool calls and `tool` results are rendered as text
 * so the model sees its own prior calls and their outcomes on the next step.
 */
export function flattenPrompt(
  prompt: LanguageModelV3Prompt,
): CompletionMessage[] {
  const out: CompletionMessage[] = [];

  for (const message of prompt) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content });
      continue;
    }

    if (message.role === "user") {
      const text = message.content
        .map((part) =>
          part.type === "text"
            ? part.text
            : `[${part.type} attachment omitted]`,
        )
        .join("\n");
      out.push({ role: "user", content: text });
      continue;
    }

    if (message.role === "assistant") {
      const chunks: string[] = [];
      for (const part of message.content) {
        if (part.type === "text") chunks.push(part.text);
        else if (part.type === "reasoning") chunks.push(part.text);
        else if (part.type === "tool-call") {
          chunks.push(
            "```json\n" +
              JSON.stringify({
                tool_call: { name: part.toolName, arguments: part.input },
              }) +
              "\n```",
          );
        }
      }
      out.push({ role: "assistant", content: chunks.join("\n") });
      continue;
    }

    if (message.role === "tool") {
      const results = message.content
        .filter((p) => p.type === "tool-result")
        .map(
          (p) =>
            `Tool "${p.toolName}" returned:\n${renderToolOutput(p.output)}`,
        )
        .join("\n\n");
      // Tool outputs come back to the model as a user-visible observation.
      out.push({ role: "user", content: results });
      continue;
    }
  }

  return out;
}

// ── Output parsing ───────────────────────────────────────────────────────────

/** Coerce one parsed JSON candidate into a tool call, or null if it isn't one. */
function toToolCall(candidate: unknown): ParsedToolCall | null {
  if (!candidate || typeof candidate !== "object") return null;
  const obj = candidate as Record<string, unknown>;
  // Accept both { tool_call: { name, arguments } } and a bare { name, arguments }.
  const call =
    obj["tool_call"] && typeof obj["tool_call"] === "object"
      ? (obj["tool_call"] as Record<string, unknown>)
      : obj;
  const name = call["name"];
  if (typeof name !== "string" || name.length === 0) return null;
  const args = call["arguments"] ?? call["input"] ?? {};
  return {
    name,
    input: typeof args === "string" ? args : JSON.stringify(args),
  };
}

/**
 * Parse a completion into prose + tool calls. Tolerant by design: it scans for
 * fenced ```json blocks first, then falls back to any top-level `{…}` object,
 * so a model that ignores the fence convention still gets its call recognised.
 */
export function parseModelText(raw: string): ParsedModelText {
  const toolCalls: ParsedToolCall[] = [];
  let text = raw;

  // 1) Fenced ```json … ``` blocks (the convention we ask for).
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  const consumed: string[] = [];
  while ((m = fence.exec(raw)) !== null) {
    const body = m[1]?.trim();
    if (!body) continue;
    const parsed = safeJson(body);
    const call = toToolCall(parsed);
    if (call) {
      toolCalls.push(call);
      consumed.push(m[0]);
    }
  }
  for (const block of consumed) text = text.replace(block, "");

  // 2) No fenced call found — try the whole trimmed body as a bare JSON object.
  if (toolCalls.length === 0) {
    const body = raw.trim();
    if (body.startsWith("{") && body.endsWith("}")) {
      const call = toToolCall(safeJson(body));
      if (call) {
        toolCalls.push(call);
        text = "";
      }
    }
  }

  return { text: text.trim(), toolCalls };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ── Usage + id helpers ───────────────────────────────────────────────────────

function toV3Usage(usage: CompletionUsage): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: usage.inputTokens,
      noCache: usage.inputTokens,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: usage.outputTokens,
      text: usage.outputTokens,
      reasoning: 0,
    },
  };
}

let idCounter = 0;
function defaultGenerateId(): string {
  idCounter += 1;
  return `ondevice-call-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── The model ────────────────────────────────────────────────────────────────

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Build a spec-correct `LanguageModelV3` over the local completion seam. The SDK
 * calls `doGenerate`/`doStream`; we render the prompt, run one completion, and
 * translate the reply into content parts (text and/or tool calls).
 */
export function createOnDeviceLanguageModel(
  deps: OnDeviceLanguageModelDeps,
): LanguageModelV3 {
  const generateId = deps.generateId ?? defaultGenerateId;

  function buildMessages(options: LanguageModelV3CallOptions): {
    messages: CompletionMessage[];
    effort?: ReasoningEffort;
  } {
    const base = flattenPrompt(options.prompt);
    const toolBlock = renderToolInstructions(options.tools);
    const jsonBlock = renderJsonInstructions(options.responseFormat);
    const extra = [toolBlock, jsonBlock].filter(Boolean).join("\n\n");

    let messages = base;
    if (extra) {
      // Fold the protocol guidance into the leading system message (or prepend one).
      if (messages[0]?.role === "system") {
        messages = [
          { role: "system", content: `${messages[0].content}\n\n${extra}` },
          ...messages.slice(1),
        ];
      } else {
        messages = [{ role: "system", content: extra }, ...messages];
      }
    }

    const rawEffort = options.providerOptions?.["oxagen"]?.["effort"];
    const effort =
      typeof rawEffort === "string" &&
      REASONING_EFFORTS.has(rawEffort as ReasoningEffort)
        ? (rawEffort as ReasoningEffort)
        : undefined;

    return { messages, ...(effort ? { effort } : {}) };
  }

  async function generate(options: LanguageModelV3CallOptions): Promise<{
    parsed: ParsedModelText;
    usage: CompletionUsage;
  }> {
    const { messages, effort } = buildMessages(options);
    const { text, usage } = await deps.complete({
      messages,
      ...(options.maxOutputTokens !== undefined
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
      ...(options.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
      ...(effort ? { effort } : {}),
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
    // When a JSON response was requested we never treat output as a tool call —
    // it is the structured answer generateObject will parse.
    const parsed =
      options.responseFormat?.type === "json"
        ? { text, toolCalls: [] }
        : parseModelText(text);
    return { parsed, usage };
  }

  function toContent(parsed: ParsedModelText): {
    content: LanguageModelV3Content[];
    ids: string[];
    finish: "stop" | "tool-calls";
  } {
    if (parsed.toolCalls.length > 0) {
      const ids: string[] = [];
      const content = parsed.toolCalls.map((c) => {
        const toolCallId = generateId();
        ids.push(toolCallId);
        return {
          type: "tool-call" as const,
          toolCallId,
          toolName: c.name,
          input: c.input,
        };
      });
      return { content, ids, finish: "tool-calls" };
    }
    return {
      content: [{ type: "text", text: parsed.text }],
      ids: [],
      finish: "stop",
    };
  }

  return {
    specificationVersion: "v3",
    provider: "oxagen-on-device",
    modelId: deps.modelId,
    supportedUrls: {},

    async doGenerate(options) {
      const { parsed, usage } = await generate(options);
      const { content, finish } = toContent(parsed);
      return {
        content,
        finishReason: { unified: finish, raw: undefined },
        usage: toV3Usage(usage),
        warnings: [],
      };
    },

    async doStream(options) {
      // The runtime is single-shot: run the whole completion, then replay it as a
      // minimal but spec-correct part stream so the engine's stream consumer works.
      const { parsed, usage } = await generate(options);
      const { content, finish } = toContent(parsed);

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });

          for (const part of content) {
            if (part.type === "text") {
              const id = generateId();
              controller.enqueue({ type: "text-start", id });
              if (part.text)
                controller.enqueue({
                  type: "text-delta",
                  id,
                  delta: part.text,
                });
              controller.enqueue({ type: "text-end", id });
            } else if (part.type === "tool-call") {
              controller.enqueue({
                type: "tool-input-start",
                id: part.toolCallId,
                toolName: part.toolName,
              });
              controller.enqueue({
                type: "tool-input-delta",
                id: part.toolCallId,
                delta: part.input,
              });
              controller.enqueue({
                type: "tool-input-end",
                id: part.toolCallId,
              });
              controller.enqueue(part);
            }
          }

          controller.enqueue({
            type: "finish",
            usage: toV3Usage(usage),
            finishReason: { unified: finish, raw: undefined },
          });
          controller.close();
        },
      });

      return { stream };
    },
  };
}
