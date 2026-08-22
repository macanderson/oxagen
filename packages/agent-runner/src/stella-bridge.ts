/**
 * The bridge between Stella's engine and Oxagen's capability kernel.
 *
 * Stella runs the agent loop inside `stella-serve` with NO ambient authority:
 * it never calls a model and never executes a tool. It emits a
 * `provider_request` or `tool_request` and parks until this host answers. That
 * is what makes the swap safe — the loop moved, the law did not. Every model
 * call still goes through `@oxagen/ai` (metered, credited, tenant-scoped) and
 * every tool call still goes through the tool surface the kernel materialized,
 * with the same IAM, entitlement and billing-admission gates as before.
 *
 * ## The one rule that makes this correct
 *
 * The AI SDK will happily run a multi-step loop and execute tools itself. Here
 * it must do NEITHER: Stella owns the loop and Stella dispatches the tools. So
 * a tool crossing into `streamAgentReply` is stripped to its DEFINITION —
 * `execute` removed, `stopWhen` pinned to one step. The model proposes a call,
 * the engine decides whether and when it runs, and the host executes it on the
 * way back through `tool_request`. If `execute` ever leaks through, the tool
 * runs twice and outside the engine's dispatch ordering.
 *
 * ## Two tool planes, one wire
 *
 * Workspace tools return a string and never throw; capability tools return the
 * kernel's validated output object and throw on denial. Both arrive here as one
 * AI SDK `ToolSet`, and both must land on Stella's `ToolOutput` union — so this
 * module normalizes shape AND failure mode, rather than assuming either plane's
 * contract holds for the other.
 */
import {
  asSchema,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
} from "@oxagen/ai";
import type {
  CompletionRequest,
  CompletionResult,
  ProviderCallContext,
  ToolCallContext,
  ToolOutput,
  ToolSchema,
} from "@oxagen/stella-engine-client";
import type { AgentAi } from "@oxagen/agent-engine";

/**
 * Workspace tools that mutate the tree. Read-only is what lets the engine
 * dispatch calls concurrently and speculate on them, so declaring a mutating
 * tool read-only corrupts the engine's concurrency contract — this list is
 * load-bearing, not documentation.
 */
const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "write_file",
  "edit_file",
]);

/** A Stella `CompletionMessage`, as it arrives on a `provider_request`. */
interface StellaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: ReadonlyArray<{ call_id: string; name: string; input: unknown }>;
  tool_results?: ReadonlyArray<{ call_id: string; output: ToolOutput }>;
}

/**
 * Declare a ToolSet to Stella.
 *
 * `asSchema` is the AI SDK's own normalizer, so a Zod-schema workspace tool and
 * a `jsonSchema()`-backed materialized capability both yield JSON Schema from
 * one call — rather than this bridge keeping a second copy of either contract.
 */
export function toToolSchemas(
  tools: ToolSet,
  opts: {
    /**
     * Names that mutate, UNIONED with the workspace mutators above. There are
     * two tool planes and only one is knowable statically: workspace tools are
     * a fixed list, but a materialized capability's mutating-ness comes from
     * its contract, which `materializeTools` reports as `mutatingToolNames`.
     * Omitting that set would silently declare every capability read-only and
     * hand the engine permission to run writes concurrently.
     */
    mutatingNames?: ReadonlySet<string>;
  } = {},
): ToolSchema[] {
  return Object.entries(tools).map(([name, def]) => {
    const schema = def.inputSchema
      ? (asSchema(def.inputSchema).jsonSchema as Record<string, unknown>)
      : { type: "object" };
    return {
      name,
      // A tool's description may be a function of call context. The engine is
      // told the surface once per turn, so resolve to the static text and fall
      // back to the name rather than shipping a stringified closure.
      description: typeof def.description === "string" ? def.description : name,
      input_schema: schema,
      read_only:
        !MUTATING_TOOL_NAMES.has(name) && !opts.mutatingNames?.has(name),
    };
  });
}

/** Stella transcript -> AI SDK transcript. */
export function toModelMessages(
  messages: readonly StellaMessage[],
): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const m of messages) {
    if (m.role === "system" || m.role === "user") {
      out.push({ role: m.role, content: m.content ?? "" } as ModelMessage);
      continue;
    }

    if (m.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const call of m.tool_calls ?? []) {
        parts.push({
          type: "tool-call",
          toolCallId: call.call_id,
          toolName: call.name,
          input: call.input,
        });
      }
      // An assistant turn with neither text nor calls is not representable;
      // emit empty text so the transcript stays valid rather than dropping a turn.
      if (parts.length === 0) parts.push({ type: "text", text: "" });
      out.push({
        role: "assistant",
        content: parts,
      } as unknown as ModelMessage);
      continue;
    }

    const results = (m.tool_results ?? []).map((r) => ({
      type: "tool-result" as const,
      toolCallId: r.call_id,
      toolName: "",
      output: { type: "text" as const, value: renderToolOutput(r.output) },
    }));
    if (results.length > 0) {
      out.push({ role: "tool", content: results } as unknown as ModelMessage);
    }
  }

  return out;
}

/** The text the model reads for a tool result, either half of the tagged union. */
export function renderToolOutput(output: ToolOutput): string {
  return "ok" in output ? output.ok.content : `Error: ${output.error.message}`;
}

/**
 * Prompt tokens served from the provider's cache.
 *
 * The AI SDK reports this nested under `inputTokenDetails.cacheReadTokens`, and
 * has also carried it flattened as `cachedInputTokens`. Read both rather than
 * pinning one: a miss does not fail, it silently reports an uncached prompt and
 * quietly distorts cache-hit telemetry.
 */
export function readCachedInputTokens(usage: unknown): number {
  const u = usage as
    | {
        cachedInputTokens?: number;
        inputTokenDetails?: { cacheReadTokens?: number };
      }
    | undefined;
  return u?.inputTokenDetails?.cacheReadTokens ?? u?.cachedInputTokens ?? 0;
}

/**
 * Run one model call for a `provider_request` and shape the answer the way
 * Stella expects.
 *
 * `cost_usd` is deliberately 0: the host owns metering. `@oxagen/ai` writes the
 * authoritative `token_usage` rows to ClickHouse on this side of the wire, and
 * a second cost computed here would be a rival number that drifts. Stella's own
 * budget guard is a guardrail over the counts, not the billing record.
 */
export function createProviderHandler(args: {
  ai: AgentAi;
  model: string;
  system: string;
  tools: ToolSet;
  /**
   * The surface's raw-stream tap. These are genuine AI SDK `fullStream` parts,
   * so the existing SSE translators keep working byte-for-byte — which is why
   * swapping the engine needs no route change.
   */
  onStreamPart?: (part: unknown) => void;
}) {
  return async function onProviderRequest(
    request: CompletionRequest,
    ctx: ProviderCallContext,
  ): Promise<CompletionResult> {
    const messages = toModelMessages(
      request.messages as unknown as StellaMessage[],
    );

    const result = args.ai.stream({
      model: args.model,
      system: args.system,
      messages,
      // Definitions only — see this module's header. Stella dispatches tools.
      tools: definitionsOnly(args.tools),
      stopWhen: stepCountIs(1),
      abortSignal: ctx.signal,
    });

    let text = "";
    for await (const part of result.fullStream) {
      args.onStreamPart?.(part);
      const p = part as { type?: string; text?: string };
      if (p.type === "text-delta" && p.text) {
        text += p.text;
        await ctx.pushDelta([{ kind: "text", text: p.text }]);
      }
    }

    const [toolCalls, usage, response] = await Promise.all([
      result.toolCalls,
      result.usage,
      result.response,
    ]);

    return {
      text,
      tool_calls: (toolCalls ?? []).map((c: Record<string, unknown>) => ({
        call_id: String(c["toolCallId"]),
        name: String(c["toolName"]),
        input: (c["input"] ?? {}) as Record<string, unknown>,
      })),
      usage: {
        // The provider reported counts iff a usage envelope came back.
        reported: usage != null,
        input_tokens: usage?.inputTokens ?? 0,
        output_tokens: usage?.outputTokens ?? 0,
        // Flattened, and a SUBSET of input_tokens rather than additional to
        // them. Getting this wrong double-counts a cached prompt.
        cached_input_tokens: readCachedInputTokens(usage),
      },
      model:
        (response as { modelId?: string } | undefined)?.modelId ?? args.model,
      cost_usd: 0,
    };
  };
}

/**
 * Answer a `tool_request` by running the tool the kernel materialized.
 *
 * This is the chokepoint the whole architecture rests on: the engine cannot
 * reach a capability except through here, so IAM, entitlement and billing
 * admission are unavoidable rather than merely conventional.
 */
export function createToolHandler(tools: ToolSet) {
  return async function onToolRequest(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolOutput> {
    const def = tools[name];
    if (!def?.execute) {
      // Naming the tool matters: the model retries against this text.
      return { error: { message: `Unknown tool: ${name}` } };
    }
    try {
      const run = def.execute as (input: unknown, options: unknown) => unknown;
      const raw = await run(input, {
        abortSignal: ctx.signal,
        toolCallId: ctx.requestId,
        messages: [],
      });
      // Workspace tools already return a string; capability tools return the
      // kernel's validated output object. Both have to reach the model as text.
      return {
        ok: { content: typeof raw === "string" ? raw : JSON.stringify(raw) },
      };
    } catch (err) {
      // A capability tool THROWS on denial. Converting it to an error output
      // rather than letting it escape is what lets the model see "denied" and
      // adapt, instead of the whole turn failing on a policy decision.
      return {
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

/**
 * Strip `execute` so the AI SDK returns tool calls instead of running them.
 * Without this the SDK executes the call itself and Stella's dispatch — its
 * ordering, its read-only partitioning, its policy gate — is bypassed entirely.
 */
export function definitionsOnly(tools: ToolSet): ToolSet {
  const out: ToolSet = {};
  for (const [name, def] of Object.entries(tools)) {
    const { execute: _dropped, ...rest } = def as Record<string, unknown>;
    out[name] = rest as ToolSet[string];
  }
  return out;
}
