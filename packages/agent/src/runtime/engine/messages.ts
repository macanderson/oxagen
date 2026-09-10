/**
 * Translation between the AI SDK's `ModelMessage` transcript, which every
 * Oxagen surface and `@oxagen/ai` speak, and Stella's `CompletionMessage`,
 * which the engine carries on the wire.
 *
 * Both directions are needed. Host to engine, once per turn, to assemble the
 * transcript the turn opens with. Engine to host, once per step, because the
 * engine owns the transcript while a turn runs and hands the whole
 * conversation back inside every `provider_request`; the host's model port
 * needs it as `ModelMessage[]`.
 *
 * Stella's `ToolResult` carries a `call_id` and an output and no tool name,
 * while the AI SDK's `ToolResultPart` requires `toolName`. So the engine to
 * host direction is one forward pass carrying the `call_id` to name table
 * built from the tool calls seen earlier in the same conversation. A result
 * whose call was never seen is rendered with the name `unknown_tool` rather
 * than dropped: a visible placeholder is recoverable, a hole reads to the
 * model as a tool that hung.
 */
import type {
  AssistantContent,
  ModelMessage,
  ToolCallPart,
  ToolResultPart,
  UserContent,
} from "ai";
import type {
  Attachment,
  CompletionMessage,
  ToolCall,
  ToolOutput,
} from "@oxagen/stella-engine-client";

/** Name used for a tool result whose originating call is not in the transcript. */
export const UNKNOWN_TOOL_NAME = "unknown_tool";

/**
 * Build the turn's opening transcript. The order — system, history, the
 * volatile context, the new user message — is the prefix the provider's
 * prompt cache is keyed on; reordering it costs every turn its cache hit.
 */
export function toCompletionMessages(args: {
  system: string;
  history: readonly ModelMessage[];
  context: readonly ModelMessage[];
  user: ModelMessage;
}): CompletionMessage[] {
  const out: CompletionMessage[] = [{ role: "system", content: args.system }];
  for (const message of args.history) out.push(...fromModelMessage(message));
  for (const message of args.context) out.push(...fromModelMessage(message));
  out.push(...fromModelMessage(args.user));
  return out;
}

/**
 * One AI SDK message becomes the engine message or messages that carry it. An
 * assistant message holding both tool calls and their results (the SDK
 * permits it) is two messages on the wire, which separates the assistant turn
 * from the `tool` role that answers it.
 */
export function fromModelMessage(message: ModelMessage): CompletionMessage[] {
  switch (message.role) {
    case "system":
      return [{ role: "system", content: message.content }];
    case "user": {
      const { text, attachments } = userParts(message.content);
      return [
        {
          role: "user",
          content: text,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      ];
    }
    case "assistant": {
      const { text, toolCalls, toolResults } = splitAssistantContent(
        message.content,
      );
      const assistant: CompletionMessage = {
        role: "assistant",
        // Absent rather than empty: a tool-call-only assistant message omits
        // `content` upstream, and matching that keeps the serialization
        // byte-stable for the prompt cache.
        ...(text ? { content: text } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
      if (toolResults.length === 0) return [assistant];
      return [assistant, { role: "tool", tool_results: toolResults }];
    }
    case "tool":
      return [
        {
          role: "tool",
          // A `tool` message can also carry an approval response, which is a
          // host-side handshake with no engine counterpart. Only real results
          // cross.
          tool_results: message.content
            .filter(
              (part): part is ToolResultPart => part.type === "tool-result",
            )
            .map((part) => ({
              call_id: part.toolCallId,
              output: toToolOutput(part.output),
            })),
        },
      ];
  }
}

/**
 * The engine's transcript becomes the AI SDK's, for the host's model port.
 * One forward pass, carrying the `call_id` to name table.
 */
export function toModelMessages(
  messages: readonly CompletionMessage[],
): ModelMessage[] {
  const toolNames = new Map<string, string>();
  const out: ModelMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "system":
        out.push({ role: "system", content: message.content ?? "" });
        break;
      case "user":
        out.push({ role: "user", content: userContent(message) });
        break;
      case "assistant": {
        for (const call of message.tool_calls ?? []) {
          toolNames.set(call.call_id, call.name);
        }
        // Text alone stays a string, which is how every surface builds
        // history and what keeps the serialisation byte-stable for the
        // prompt cache; parts appear only when there is a call to carry.
        if ((message.tool_calls ?? []).length === 0) {
          out.push({ role: "assistant", content: message.content ?? "" });
          break;
        }
        const parts: Exclude<AssistantContent, string> = [];
        if (message.content)
          parts.push({ type: "text", text: message.content });
        for (const call of message.tool_calls ?? []) {
          parts.push({
            type: "tool-call",
            toolCallId: call.call_id,
            toolName: call.name,
            input: call.input,
          } satisfies ToolCallPart);
        }
        // An assistant message with neither text nor calls still occupies a
        // position in the conversation; keep it as empty text rather than
        // dropping it, so the alternation the providers expect is preserved.
        out.push({
          role: "assistant",
          content: parts.length > 0 ? parts : "",
        });
        break;
      }
      case "tool": {
        const parts: ToolResultPart[] = (message.tool_results ?? []).map(
          (result) => ({
            type: "tool-result",
            toolCallId: result.call_id,
            toolName: toolNames.get(result.call_id) ?? UNKNOWN_TOOL_NAME,
            output: fromToolOutput(result.output),
          }),
        );
        if (parts.length > 0) out.push({ role: "tool", content: parts });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** The engine's `ToolOutput` as the SDK's `ToolResultOutput`. */
export function fromToolOutput(output: ToolOutput): ToolResultPart["output"] {
  if ("ok" in output) return { type: "text", value: output.ok.content };
  return { type: "error-text", value: output.error.message };
}

/** The SDK's `ToolResultOutput` as the engine's `ToolOutput`. */
export function toToolOutput(output: ToolResultPart["output"]): ToolOutput {
  switch (output.type) {
    case "text":
      return { ok: { content: output.value } };
    case "error-text":
      return { error: { message: output.value } };
    case "json":
      return { ok: { content: JSON.stringify(output.value) } };
    case "error-json":
      return { error: { message: JSON.stringify(output.value) } };
    default:
      // Multi-part content and a denied execution have no lossless engine
      // spelling; JSON is the honest rendering, the model sees the whole
      // value rather than a summary that hides part of it.
      return { ok: { content: JSON.stringify(output) } };
  }
}

/** A user message's text and its binary parts as engine attachments. */
function userParts(content: UserContent): {
  text: string;
  attachments: Attachment[];
} {
  if (typeof content === "string") return { text: content, attachments: [] };
  const chunks: string[] = [];
  const attachments: Attachment[] = [];
  let n = 0;
  for (const part of content) {
    if (part.type === "text") {
      chunks.push(part.text);
      continue;
    }
    if (part.type === "image" || part.type === "file") {
      n += 1;
      const bytes = toBytes(part.type === "image" ? part.image : part.data);
      const mediaType =
        part.mediaType ??
        (part.type === "image" ? "image/png" : "application/octet-stream");
      attachments.push({
        name: `attachment-${n}`,
        media_type: mediaType,
        byte_len: bytes.byteLength,
        source: { type: "data", base64: Buffer.from(bytes).toString("base64") },
      });
      continue;
    }
    throw new UnsupportedTurnContentError(
      `a "${(part as { type: string }).type}" user content part`,
    );
  }
  return { text: chunks.join("\n"), attachments };
}

/** An engine user message, with its attachments back as SDK parts. */
function userContent(message: CompletionMessage): UserContent {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return message.content ?? "";
  const parts: Exclude<UserContent, string> = [];
  if (message.content) parts.push({ type: "text", text: message.content });
  for (const attachment of attachments) {
    if (attachment.source.type !== "data") {
      // A path is the engine's own file system, which this host never mounts.
      throw new UnsupportedTurnContentError(
        `an attachment sourced from a path (${attachment.name})`,
      );
    }
    const data = Buffer.from(attachment.source.base64, "base64");
    if (attachment.media_type.startsWith("image/")) {
      parts.push({
        type: "image",
        image: data,
        mediaType: attachment.media_type,
      });
    } else {
      parts.push({ type: "file", data, mediaType: attachment.media_type });
    }
  }
  return parts;
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") {
    // A data: URL or a bare base64 string; anything else is a URL the host
    // would have to fetch, which is not a thing a governance turn does.
    const comma = data.indexOf(",");
    const base64 =
      data.startsWith("data:") && comma !== -1 ? data.slice(comma + 1) : data;
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  if (data instanceof URL) {
    throw new UnsupportedTurnContentError("an attachment given by URL");
  }
  throw new UnsupportedTurnContentError("an attachment of unknown shape");
}

function splitAssistantContent(content: AssistantContent): {
  text: string;
  toolCalls: ToolCall[];
  toolResults: { call_id: string; output: ToolOutput }[];
} {
  if (typeof content === "string") {
    return { text: content, toolCalls: [], toolResults: [] };
  }
  const chunks: string[] = [];
  const toolCalls: ToolCall[] = [];
  const toolResults: { call_id: string; output: ToolOutput }[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        chunks.push(part.text);
        break;
      case "tool-call":
        toolCalls.push({
          call_id: part.toolCallId,
          name: part.toolName,
          input: part.input ?? {},
        });
        break;
      case "tool-result":
        toolResults.push({
          call_id: part.toolCallId,
          output: toToolOutput(part.output),
        });
        break;
      case "reasoning":
        // Reasoning is provider-scoped and is not replayed to a different
        // provider; the host re-derives it per call.
        break;
      default:
        throw new UnsupportedTurnContentError(
          `an assistant "${(part as { type: string }).type}" content part`,
        );
    }
  }
  return { text: chunks.join(""), toolCalls, toolResults };
}

/**
 * Raised when a turn carries something the engine wire cannot represent.
 * Refusing is the point: a turn whose parts were silently dropped has the
 * model answering confidently about something it never saw.
 */
export class UnsupportedTurnContentError extends Error {
  override readonly name = "UnsupportedTurnContentError";
  constructor(what: string) {
    super(`the engine wire cannot carry ${what}`);
  }
}
