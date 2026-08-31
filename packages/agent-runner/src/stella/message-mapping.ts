/**
 * Translation between the AI SDK's `ModelMessage` transcript — what every
 * oxagen surface and the `AgentAi` port speak — and Stella's
 * `CompletionMessage`, the shape the sidecar carries over the wire.
 *
 * Both directions are needed, and for different reasons:
 *
 * - **host → engine**, once per turn, to assemble `TurnRequest.messages` from
 *   the caller's `system` / `history` / `instruction`.
 * - **engine → host**, once per step, because Stella owns the transcript while
 *   a turn runs and hands the whole conversation back inside every
 *   `provider_request`. The host's model adapter needs it as `ModelMessage[]`.
 *
 * ## The `toolName` problem
 *
 * Stella's `ToolResult` carries `call_id` and an output, and no tool name — the
 * name lives on the `ToolCall` that raised it. The AI SDK's `ToolResultPart`
 * requires `toolName`. So the engine → host direction cannot be a per-message
 * map: it has to carry the `call_id → name` table built from the tool calls
 * seen earlier in the same conversation. {@link toModelMessages} does that in
 * one forward pass.
 *
 * A result whose call was never seen is not dropped — it is rendered with the
 * name `unknown_tool`, because losing the result entirely would leave the model
 * looking at a tool call with no answer, which reads to it as a tool that hung.
 * A visible placeholder is recoverable; a hole is not.
 */
import type {
  AssistantContent,
  ModelMessage,
  ToolCallPart,
  ToolResultPart,
  UserContent,
} from "ai";
import type {
  CompletionMessage,
  ToolCall as StellaToolCall,
  ToolOutput,
} from "@oxagen/stella-engine-client";

/** Name used for a tool result whose originating call is not in the transcript. */
export const UNKNOWN_TOOL_NAME = "unknown_tool";

/**
 * Raised when a turn carries something the Stella path cannot represent.
 *
 * Refusing is the point. §5 of the adoption plan ("What does not come across")
 * names capability loss at cutover as the failure mode to design against, and a
 * turn whose images were silently dropped is exactly that: the model answers
 * confidently about an attachment it never saw, and nothing in the transcript
 * records that anything went missing.
 */
export class UnsupportedTurnContentError extends Error {
  constructor(what: string, issue: string) {
    super(
      `the Stella engine path cannot carry ${what} yet (${issue}) — ` +
        `run this turn on the TS engine until it can`,
    );
    this.name = "UnsupportedTurnContentError";
  }
}

/**
 * Build the turn's opening transcript.
 *
 * The ordering — system, then history, then the new instruction — is the same
 * one `runCodingAgent` assembles, so a turn's prompt prefix is unchanged by
 * which engine runs it. That matters beyond tidiness: an identical prefix is
 * what lets Phase D compare the two engines on cost without the comparison
 * being confounded by a different cache-hit rate.
 */
export function toCompletionMessages(args: {
  system: string;
  history?: readonly ModelMessage[];
  instruction: string;
}): CompletionMessage[] {
  const messages: CompletionMessage[] = [
    { role: "system", content: args.system },
  ];
  for (const message of args.history ?? []) {
    messages.push(...fromModelMessage(message));
  }
  messages.push({ role: "user", content: args.instruction });
  return messages;
}

/**
 * One AI SDK message → the Stella message(s) that carry it.
 *
 * Returns a list because an assistant message holding both tool calls and
 * their results (the SDK permits it) is two messages on Stella's wire, which
 * separates the assistant turn from the `tool` role that answers it.
 */
export function fromModelMessage(message: ModelMessage): CompletionMessage[] {
  switch (message.role) {
    case "system":
      return [{ role: "system", content: message.content }];

    case "user":
      return [{ role: "user", content: userText(message.content) }];

    case "assistant": {
      const { text, toolCalls, toolResults } = splitAssistantContent(
        message.content,
      );
      const assistant: CompletionMessage = {
        role: "assistant",
        // Absent, not empty: a tool-call-only assistant message omits
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
          // host-side handshake with no engine counterpart — Stella parks a
          // `tool_request` until the host answers, so approval never reaches
          // the transcript. Only real results cross.
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
 * The engine's transcript → the AI SDK's, for handing to the host's model port.
 *
 * One forward pass, carrying the `call_id → name` table described in the module
 * doc.
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
        out.push({ role: "user", content: message.content ?? "" });
        break;

      case "assistant": {
        for (const call of message.tool_calls ?? []) {
          toolNames.set(call.call_id, call.name);
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
        // position in the conversation; render it as empty text rather than
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
    }
  }

  return out;
}

/** Stella's `ToolOutput` → the SDK's `ToolResultOutput`. */
export function fromToolOutput(output: ToolOutput): ToolResultPart["output"] {
  if ("ok" in output) return { type: "text", value: output.ok.content };
  return { type: "error-text", value: output.error.message };
}

/** The SDK's `ToolResultOutput` → Stella's `ToolOutput`. */
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
      // `content` (multi-part) and `execution-denied` have no lossless Stella
      // spelling; JSON is the honest rendering — the model sees the whole
      // value rather than a summary that hides part of it.
      return { ok: { content: JSON.stringify(output) } };
  }
}

/**
 * Flatten a user message's content to text, refusing anything that would be
 * silently lost.
 */
function userText(content: UserContent): string {
  if (typeof content === "string") return content;
  const chunks: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      chunks.push(part.text);
      continue;
    }
    throw new UnsupportedTurnContentError(
      `a "${part.type}" content part`,
      "Stella's CompletionMessage.attachments wire shape is unverified against a running sidecar",
    );
  }
  return chunks.join("\n");
}

function splitAssistantContent(content: AssistantContent): {
  text: string;
  toolCalls: StellaToolCall[];
  toolResults: { call_id: string; output: ToolOutput }[];
} {
  if (typeof content === "string") {
    return { text: content, toolCalls: [], toolResults: [] };
  }
  const chunks: string[] = [];
  const toolCalls: StellaToolCall[] = [];
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
          input: (part.input ?? {}) as Record<string, unknown>,
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
        // provider; the host re-derives it per call. Dropping it here is the
        // same thing the TS loop does when it rebuilds a request.
        break;
      default:
        throw new UnsupportedTurnContentError(
          `an assistant "${part.type}" content part`,
          "no Stella CompletionMessage field carries it",
        );
    }
  }
  return { text: chunks.join(""), toolCalls, toolResults };
}
