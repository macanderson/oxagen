/**
 * OpenAI-compatible agent LLM proxy for the Oxagen CLI (ADR-019 task B4).
 *
 * The CLI runs its agentic coding loop locally but routes ALL model inference
 * through the platform — there is no BYOK gateway key on the client. The CLI's
 * `@ai-sdk/openai-compatible` provider points its `baseURL` at this surface and
 * speaks the standard OpenAI Chat Completions wire format:
 *
 *   POST /v1/agent/llm/chat/completions
 *   Authorization: Bearer <platform-api-key>   // org+workspace bound to the key
 *   { model, messages, tools?, tool_choice?, stream?, max_tokens?, temperature? }
 *
 * We translate the request into AI SDK `ModelMessage[]` + schema-only tools, run
 * it through `@oxagen/ai`'s `streamAgentReply` (the single metering/telemetry
 * chokepoint → Vercel AI Gateway), then translate the AI SDK `fullStream` back
 * into OpenAI `chat.completion.chunk` SSE so the client's openai-compatible
 * provider parses it natively. Tools are declared WITHOUT an `execute` fn: the
 * model emits tool calls, the CLI executes them locally on the user's machine,
 * and returns the results on the next request (the standard OpenAI tool loop).
 * The agent loop therefore lives on the CLI; the platform is a pure, metered
 * inference proxy with no server-side tool execution here.
 *
 * Why a full proxy and not a "hand the CLI a gateway key" shortcut: routing the
 * inference through `streamAgentReply` is what emits token_usage + duration +
 * cost telemetry to ClickHouse and debits the org's credits. A leaked gateway
 * key would bypass every meter — the exact opposite of the "no BYOK" goal.
 *
 * Auth + scope: this route is mounted in `app.ts` behind `authMiddleware`, which
 * resolves the Bearer platform API key and binds org+workspace from the key. The
 * key carries the scope, so the surface deliberately sits OUTSIDE the
 * `/:org_slug/:workspace_slug` path group (the OpenAI wire format has no slugs).
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  streamAgentReply,
  selectModel,
  tool,
  jsonSchema,
  type ModelMessage,
  type ToolSet,
  type JSONSchema7,
} from "@oxagen/ai";
import { capabilityContext } from "../../lib/context";
import { logger } from "../../middleware/logger";
import type { AppEnv } from "../../app";

// ── Request schema (subset of the OpenAI Chat Completions request) ─────────────

const ContentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({ url: z.string() }),
  }),
]);

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  // string content, multimodal content-part array, or null (assistant turns
  // that are pure tool calls carry content: null).
  content: z
    .union([z.string(), z.array(ContentPartSchema), z.null()])
    .optional(),
  name: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal("function").optional(),
        function: z.object({
          name: z.string(),
          // OpenAI tool-call arguments are a JSON-encoded string.
          arguments: z.string(),
        }),
      }),
    )
    .optional(),
  tool_call_id: z.string().optional(),
});

const ToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    // Raw JSON Schema for the tool's parameters; fed to `jsonSchema()`.
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

const ToolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({
    type: z.literal("function"),
    function: z.object({ name: z.string() }),
  }),
]);

const BodySchema = z.object({
  model: z.string().min(1),
  messages: z.array(MessageSchema).min(1),
  tools: z.array(ToolSchema).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  stream: z.boolean().optional().default(false),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  // Convenience: a top-level system prompt, merged with any system-role
  // messages. Most OpenAI clients send system as a message, but accept both.
  system: z.string().optional(),
  // Reasoning effort for models with a thinking mode (OpenAI's canonical field).
  // Forwarded by the Oxagen CLI via provider options; streamAgentReply applies it
  // per-model and it is a no-op for models without a reasoning mode.
  reasoning_effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .optional(),
});

type OpenAiMessage = z.infer<typeof MessageSchema>;
type OpenAiContent = OpenAiMessage["content"];
type OpenAiTool = z.infer<typeof ToolSchema>;
type OpenAiToolChoice = z.infer<typeof ToolChoiceSchema>;

// ── Response shapes (OpenAI Chat Completions) ──────────────────────────────────

interface OpenAiToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

interface OpenAiDelta {
  role?: "assistant";
  content?: string;
  tool_calls?: OpenAiToolCallDelta[];
}

interface OpenAiChunkChoice {
  index: number;
  delta: OpenAiDelta;
  finish_reason: string | null;
}

interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /**
   * OpenAI cache-read breakdown. Surfaced so clients (the Oxagen CLI status line)
   * can show cache hit/miss: `cached_tokens` are prompt tokens served from the
   * provider's prompt cache (a "hit"); `prompt_tokens - cached_tokens` were billed
   * fresh (a "miss"). The AI SDK's openai-compatible provider maps this back to
   * `usage.cachedInputTokens`.
   */
  prompt_tokens_details?: { cached_tokens: number };
}

/** Build the OpenAI usage object, including the cache-read detail when present. */
function toOpenAiUsage(u: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  // AI SDK v7 usage shape: cache reads live under `inputTokenDetails`.
  inputTokenDetails?: { cacheReadTokens?: number };
}): OpenAiUsage {
  const prompt_tokens = u.inputTokens ?? 0;
  const completion_tokens = u.outputTokens ?? 0;
  const cacheReadTokens = u.inputTokenDetails?.cacheReadTokens;
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: u.totalTokens ?? prompt_tokens + completion_tokens,
    ...(cacheReadTokens
      ? { prompt_tokens_details: { cached_tokens: cacheReadTokens } }
      : {}),
  };
}

interface OpenAiChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAiChunkChoice[];
  usage?: OpenAiUsage;
}

interface OpenAiResponseToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiResponseMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: OpenAiResponseToolCall[];
}

// ── Message / tool conversion (OpenAI wire format → AI SDK) ─────────────────────

type AssistantPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };

type UserPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string };

const EMPTY_OBJECT_SCHEMA: JSONSchema7 = { type: "object", properties: {} };

/** Flatten OpenAI message content to plain text (drops non-text parts). */
function contentToText(content: OpenAiContent): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
  }
  return "";
}

/** Map OpenAI user content to AI SDK user content (text + image parts). */
function toUserContent(content: OpenAiContent): string | UserPart[] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(
      (p): UserPart =>
        p.type === "text"
          ? { type: "text", text: p.text }
          : { type: "image", image: p.image_url.url },
    );
  }
  return "";
}

/** Tolerant JSON.parse for tool-call argument strings (model output). */
function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Convert OpenAI messages into AI SDK `ModelMessage[]`, hoisting system-role
 * messages into a single `system` string (so `streamAgentReply` can mark it as
 * an Anthropic cache breakpoint). Tool-role messages resolve their tool name
 * from the preceding assistant tool_calls (OpenAI tool results carry only the
 * tool_call_id, but the AI SDK requires a tool name on each result part).
 */
function convertMessages(messages: OpenAiMessage[]): {
  system?: string;
  modelMessages: ModelMessage[];
} {
  const systemParts: string[] = [];
  const modelMessages: ModelMessage[] = [];
  const toolNameById = new Map<string, string>();

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        systemParts.push(contentToText(msg.content));
        break;
      case "user":
        modelMessages.push({
          role: "user",
          content: toUserContent(msg.content),
        });
        break;
      case "assistant": {
        const toolCalls = msg.tool_calls ?? [];
        if (toolCalls.length > 0) {
          const parts: AssistantPart[] = [];
          const text = contentToText(msg.content);
          if (text.length > 0) parts.push({ type: "text", text });
          for (const tc of toolCalls) {
            toolNameById.set(tc.id, tc.function.name);
            parts.push({
              type: "tool-call",
              toolCallId: tc.id,
              toolName: tc.function.name,
              input: safeParseJson(tc.function.arguments),
            });
          }
          modelMessages.push({ role: "assistant", content: parts });
        } else {
          modelMessages.push({
            role: "assistant",
            content: contentToText(msg.content),
          });
        }
        break;
      }
      case "tool": {
        const toolCallId = msg.tool_call_id ?? "";
        modelMessages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId,
              toolName: toolNameById.get(toolCallId) ?? "tool",
              output: { type: "text", value: contentToText(msg.content) },
            },
          ],
        });
        break;
      }
    }
  }

  const system = systemParts.filter((s) => s.length > 0).join("\n\n");
  return { ...(system.length > 0 ? { system } : {}), modelMessages };
}

/**
 * Build a schema-only `ToolSet` from OpenAI tool definitions. No `execute` fn:
 * the model emits tool-call parts and the CLI executes them locally.
 */
function convertTools(tools: OpenAiTool[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.function.name] = tool({
      ...(t.function.description
        ? { description: t.function.description }
        : {}),
      inputSchema: jsonSchema(
        (t.function.parameters as JSONSchema7 | undefined) ??
          EMPTY_OBJECT_SCHEMA,
      ),
    });
  }
  return set;
}

type ResolvedToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "tool"; toolName: string };

function convertToolChoice(
  tc: OpenAiToolChoice | undefined,
): ResolvedToolChoice | undefined {
  if (tc === undefined) return undefined;
  if (typeof tc === "string") return tc;
  return { type: "tool", toolName: tc.function.name };
}

/** Map AI SDK finish reasons to the OpenAI finish_reason vocabulary. */
function mapFinishReason(
  reason: string,
): "stop" | "length" | "tool_calls" | "content_filter" {
  switch (reason) {
    case "tool-calls":
      return "tool_calls";
    case "length":
      return "length";
    case "content-filter":
      return "content_filter";
    default:
      return "stop";
  }
}

/** Stringify a tool-call input back to the OpenAI JSON-string `arguments`. */
function stringifyArgs(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

function errorText(err: unknown): string {
  return err instanceof Error
    ? err.message
    : typeof err === "string"
      ? err
      : "Stream error";
}

function openAiError(
  message: string,
  type: string,
): { error: { message: string; type: string } } {
  return { error: { message, type } };
}

// ── Route ──────────────────────────────────────────────────────────────────────

export const agentLlmRoute = new Hono<AppEnv>();

// POST /chat/completions — mounted at /v1/agent/llm in app.ts.
agentLlmRoute.post("/chat/completions", async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json(
      openAiError("Invalid JSON body", "invalid_request_error"),
      400,
    );
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      openAiError(
        parsed.error.issues[0]?.message ?? "Invalid request body",
        "invalid_request_error",
      ),
      400,
    );
  }

  const body = parsed.data;
  // Throws 400 when the API key did not bind org+workspace (e.g. a cookie-only
  // session). The CLI always authenticates with a scoped platform key.
  const ctx = capabilityContext(c);

  const { system, modelMessages } = convertMessages(body.messages);
  const mergedSystem =
    [body.system, system]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("\n\n") || undefined;
  const tools = convertTools(body.tools);
  const toolChoice = convertToolChoice(body.tool_choice);
  const maxOutputTokens = body.max_tokens ?? body.max_completion_tokens;

  const created = Math.floor(Date.now() / 1000);
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const model = body.model;

  // The single AI chokepoint: every call is metered/billed via onFinish and
  // routed through the Vercel AI Gateway. Surface "agent" tags these turns as
  // agent-loop inference in the token-usage analytics.
  //
  // `abortSignal` is the request's own signal, so a CLI that Ctrl-C's or drops
  // the socket aborts the in-flight model call instead of streaming — and
  // billing — tokens to nobody. Same wiring chat.stream.ts gives the engine.
  function startReply() {
    return streamAgentReply({
      messages: modelMessages,
      model: selectModel({ model }),
      abortSignal: c.req.raw.signal,
      ...(tools ? { tools } : {}),
      ...(mergedSystem ? { system: mergedSystem } : {}),
      ...(body.reasoning_effort ? { effort: body.reasoning_effort } : {}),
      ...(body.temperature !== undefined
        ? { temperature: body.temperature }
        : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      telemetry: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: "agent",
        messageId: ctx.requestId,
      },
    });
  }

  // ── Non-streaming: assemble one chat.completion object ───────────────────────
  if (!body.stream) {
    try {
      const result = startReply();
      const [text, toolCalls, finishReason, totalUsage] = await Promise.all([
        result.text,
        result.toolCalls,
        result.finishReason,
        result.totalUsage,
      ]);

      const message: OpenAiResponseMessage = {
        role: "assistant",
        content: text.length > 0 ? text : null,
      };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls.map((tc) => ({
          id: tc.toolCallId,
          type: "function",
          function: { name: tc.toolName, arguments: stringifyArgs(tc.input) },
        }));
      }

      return c.json({
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: mapFinishReason(finishReason),
          },
        ],
        usage: toOpenAiUsage(totalUsage),
      });
    } catch (err) {
      const reason = errorText(err);
      logger.error(
        {
          reason,
          requestId: ctx.requestId,
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
        },
        "[agent.llm] non-stream generation failed",
      );
      return c.json(openAiError(reason, "upstream_error"), 502);
    }
  }

  // ── Streaming: translate AI SDK fullStream → OpenAI SSE chunks ───────────────
  const encoder = new TextEncoder();
  const responseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Latch on the first failed write instead of throwing out of the loop: a
      // client disconnect closes the controller, and an unguarded enqueue would
      // surface as a bogus "[agent.llm] stream failed" error entry. Same latch
      // chat.stream.ts and agent.run.ts use.
      let closed = false;
      function write(payload: string): void {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      }
      function emit(chunk: OpenAiChunk): void {
        write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      function chunkOf(
        delta: OpenAiDelta,
        finish_reason: string | null,
      ): OpenAiChunk {
        return {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason }],
        };
      }

      // OpenAI streams tool calls keyed by a positional index. Assign indices in
      // first-seen order; track which calls have had their arguments streamed so
      // we don't double-emit when both tool-input-delta and a final tool-call
      // part arrive for the same id.
      const toolIndexById = new Map<string, number>();
      const argsStreamed = new Set<string>();
      let nextToolIndex = 0;
      let finishReason = "stop";
      let usage: OpenAiUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };

      function openTool(id: string, name: string): number {
        const existing = toolIndexById.get(id);
        if (existing !== undefined) return existing;
        const index = nextToolIndex++;
        toolIndexById.set(id, index);
        emit(
          chunkOf(
            {
              tool_calls: [
                {
                  index,
                  id,
                  type: "function",
                  function: { name, arguments: "" },
                },
              ],
            },
            null,
          ),
        );
        return index;
      }

      try {
        const result = startReply();
        // Leading role chunk (standard OpenAI stream preamble).
        emit(chunkOf({ role: "assistant" }, null));

        for await (const raw of result.fullStream as AsyncIterable<unknown>) {
          const part = raw as { type?: string };
          switch (part.type) {
            case "text-delta": {
              const { text } = raw as { text: string };
              if (text.length > 0) emit(chunkOf({ content: text }, null));
              break;
            }
            case "tool-input-start": {
              const { id, toolName } = raw as { id: string; toolName: string };
              openTool(id, toolName);
              break;
            }
            case "tool-input-delta": {
              const { id, delta } = raw as { id: string; delta: string };
              const index = toolIndexById.get(id);
              if (index !== undefined && delta.length > 0) {
                argsStreamed.add(id);
                emit(
                  chunkOf(
                    {
                      tool_calls: [{ index, function: { arguments: delta } }],
                    },
                    null,
                  ),
                );
              }
              break;
            }
            case "tool-call": {
              const { toolCallId, toolName, input } = raw as {
                toolCallId: string;
                toolName: string;
                input: unknown;
              };
              const index = openTool(toolCallId, toolName);
              // Only emit full arguments if they were not already streamed via
              // tool-input-delta parts (some providers skip streaming inputs).
              if (!argsStreamed.has(toolCallId)) {
                emit(
                  chunkOf(
                    {
                      tool_calls: [
                        {
                          index,
                          function: { arguments: stringifyArgs(input) },
                        },
                      ],
                    },
                    null,
                  ),
                );
              }
              break;
            }
            case "finish": {
              const { finishReason: fr, totalUsage } = raw as {
                finishReason: string;
                totalUsage: {
                  inputTokens?: number;
                  outputTokens?: number;
                  totalTokens?: number;
                  inputTokenDetails?: { cacheReadTokens?: number };
                };
              };
              finishReason = fr;
              usage = toOpenAiUsage(totalUsage);
              break;
            }
            case "error": {
              // AI SDK surfaces model-layer failures (rate limits, context
              // overflow) as yielded `error` parts, not thrown exceptions. Emit
              // an OpenAI-style error object; the openai-compatible client turns
              // an unparseable chunk into an error stream part.
              const message = errorText((raw as { error?: unknown }).error);
              logger.error(
                {
                  message,
                  requestId: ctx.requestId,
                  orgId: ctx.orgId,
                  workspaceId: ctx.workspaceId,
                },
                "[agent.llm] stream error part",
              );
              write(
                `data: ${JSON.stringify(openAiError(message, "upstream_error"))}\n\n`,
              );
              break;
            }
            default:
              break;
          }
        }

        // Terminal finish_reason chunk, then a usage-only chunk (OpenAI sends
        // usage in a trailing choices:[] chunk).
        emit(chunkOf({}, mapFinishReason(finishReason)));
        emit({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage,
        });
      } catch (err) {
        const message = errorText(err);
        logger.error(
          {
            message,
            requestId: ctx.requestId,
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
          },
          "[agent.llm] stream failed",
        );
        write(
          `data: ${JSON.stringify(openAiError(message, "upstream_error"))}\n\n`,
        );
      } finally {
        write("data: [DONE]\n\n");
        closed = true;
        try {
          controller.close();
        } catch {
          // Controller may already be closed.
        }
      }
    },
  });

  return new Response(responseStream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
});
