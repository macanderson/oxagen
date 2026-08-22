/**
 * Run one platform agent turn on the Stella engine.
 *
 * This satisfies the same contract `runCodingAgent` did — same options in, same
 * `RunCodingAgentResult` out, same `onStreamPart` / `onEvent` callbacks — which
 * is why swapping the engine touches no route. What changed is who owns the
 * loop: Stella decides the steps, and this process answers the model and tool
 * calls it asks for.
 *
 * ## The sidecar is supplied, not spawned
 *
 * `OXAGEN_STELLA_SERVE_URL` / `OXAGEN_STELLA_SERVE_TOKEN` point at a
 * `stella-serve` this process does not own. That is deliberate. Stella's
 * provider credentials and config are process-global, so one engine process per
 * trust boundary is a hard requirement rather than a preference — and the unit
 * of isolation is a worker SLOT, not a worker process (a worker driving two
 * runs concurrently needs two sidecars). Deciding that is an orchestration job;
 * having Node fork and reap Rust processes would put the hardest part of the
 * deployment in the least suitable place.
 */
import {
  buildWorkspaceTools,
  changedFilesFromDiff,
} from "@oxagen/agent-engine";
import type {
  RunCodingAgentOptions,
  RunCodingAgentResult,
  TurnStopReason,
} from "@oxagen/agent-engine";
import type { ToolSet } from "@oxagen/ai";
import {
  StellaSidecarClient,
  type CompletionMessage,
} from "@oxagen/stella-engine-client";
import {
  createProviderHandler,
  createToolHandler,
  toToolSchemas,
} from "./stella-bridge";

/**
 * How long the host may take to answer one reverse request.
 *
 * The engine's default is five minutes and it clamps this to one hour, which is
 * the ceiling asked for here. The distinction that matters: for a PROVIDER
 * request the deadline is an IDLE bound — every streamed delta re-arms it — but
 * for a TOOL request it is a fixed TOTAL. An Oxagen tool can legitimately park
 * on a human approval, so the default would hard-fail exactly the capability
 * the approval gate exists to protect. One hour is the most the engine will
 * grant; an approval parked longer than that still fails, and moving that
 * ceiling needs a change on the Stella side.
 */
const REVERSE_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

export interface StellaEndpoint {
  url: string;
  token: string;
}

/**
 * Resolve the sidecar for this worker slot. Throws rather than falling back: a
 * missing sidecar must fail loudly at the seam, not silently degrade a turn
 * into some other engine.
 */
export function resolveStellaEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): StellaEndpoint {
  const url = env["OXAGEN_STELLA_SERVE_URL"];
  const token = env["OXAGEN_STELLA_SERVE_TOKEN"];
  if (!url || !token) {
    throw new Error(
      "Stella engine is not configured: set OXAGEN_STELLA_SERVE_URL and OXAGEN_STELLA_SERVE_TOKEN to the stella-serve instance for this worker slot.",
    );
  }
  return { url, token };
}

export interface StellaRunDeps {
  client?: StellaSidecarClient;
  endpoint?: StellaEndpoint;
}

export async function runCodingAgentOnStella(
  opts: RunCodingAgentOptions,
  deps: StellaRunDeps = {},
): Promise<RunCodingAgentResult> {
  // Resolve the endpoint only when a client was NOT supplied: reading it
  // eagerly would demand ambient configuration even from a caller that already
  // brought its own connection.
  const client =
    deps.client ??
    (() => {
      const endpoint = deps.endpoint ?? resolveStellaEndpoint();
      return new StellaSidecarClient({
        baseUrl: endpoint.url,
        token: endpoint.token,
      });
    })();

  // The same tool surface the model has always seen: workspace tools only when
  // a repository is attached, plus whatever the caller merges in, through the
  // caller's transform. A conversational turn with no workspace advertises no
  // filesystem tools, exactly as before.
  const workspaceTools: ToolSet = opts.workspace
    ? (buildWorkspaceTools(opts.workspace, {
        onEvent: opts.onEvent,
        signal: opts.signal,
      }) as ToolSet)
    : {};
  const merged: ToolSet = {
    ...workspaceTools,
    ...((opts.extraTools ?? {}) as ToolSet),
  };
  // `wrapTools` is the caller's single seam for cross-cutting tool behaviour
  // (permission gates, lifecycle hooks, per-tool timeouts). It must be applied
  // BEFORE the surface is declared to the engine, or the engine advertises one
  // set of tools and the host runs a different one.
  const tools = opts.wrapTools
    ? (opts.wrapTools(merged as never) as ToolSet)
    : merged;

  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
  };
  let steps = 0;
  let finalText = "";
  let stopReason: TurnStopReason | undefined;
  // The engine hands back the whole transcript on every provider_request, so
  // the newest one is the turn's history without mirroring it here.
  let transcript: RunCodingAgentResult["messages"] = (
    opts.history ?? []
  ).slice();

  // The budget gate stops a turn by aborting, which unwinds the engine at its
  // next STEP boundary — never mid-tool. Composed with the caller's signal so a
  // user cancel and a budget stop take the identical path, while still
  // reporting which one happened.
  const abort = new AbortController();
  opts.signal?.addEventListener("abort", () => abort.abort(), { once: true });

  const provider = createProviderHandler({
    ai: opts.ai,
    model: opts.model ?? "",
    system: opts.system ?? "",
    tools,
    onStreamPart: opts.onStreamPart,
  });
  const runTool = createToolHandler(tools);

  const history = (opts.history ?? []) as unknown as CompletionMessage[];

  const run = await client.runTurn(
    {
      provider_id: "oxagen",
      messages: [...history, { role: "user", content: opts.instruction }],
      tools: toToolSchemas(tools, {
        mutatingNames: new Set(opts.mutatingToolNames ?? []),
      }),
      ...(opts.maxSteps != null ? { max_steps: opts.maxSteps } : {}),
      reverse_request_timeout_ms: REVERSE_REQUEST_TIMEOUT_MS,
    },
    {
      onProviderRequest: async (request, ctx) => {
        steps++;
        transcript =
          request.messages as unknown as RunCodingAgentResult["messages"];
        const result = await provider(request, ctx);
        usage.inputTokens += result.usage.input_tokens;
        usage.outputTokens += result.usage.output_tokens;
        usage.cachedInputTokens += result.usage.cached_input_tokens ?? 0;
        if (result.text) finalText = result.text;
        if (opts.budgetGuard) {
          usage.totalTokens = usage.inputTokens + usage.outputTokens;
          // Contract: the guard must not throw. Honour that defensively — a
          // broken meter must never wedge a turn.
          const verdict = await opts
            .budgetGuard({ ...usage })
            .catch(() => "continue" as const);
          if (verdict === "stop") {
            stopReason = "budget";
            abort.abort();
          }
        }
        return result;
      },
      onToolRequest: async (name, input, ctx) => {
        const output = await runTool(name, input, ctx);
        // The AI SDK emits `tool-call` parts on its own because the tools are
        // declared; only the RESULT is ours to synthesize, because the engine —
        // not the SDK — is what actually ran the call.
        opts.onStreamPart?.({
          type: "tool-result",
          toolCallId: ctx.requestId,
          toolName: name,
          output: "ok" in output ? output.ok.content : output.error.message,
          isError: !("ok" in output),
        });
        return output;
      },
    },
    { signal: abort.signal },
  );

  if (run.outcome.status === "completed" && run.outcome.text)
    finalText = run.outcome.text;
  if (
    opts.maxSteps != null &&
    steps >= opts.maxSteps &&
    run.outcome.status !== "completed"
  ) {
    stopReason ??= "max-steps";
  }

  const diff = opts.workspace ? await opts.workspace.diff() : "";
  const changedFiles = opts.workspace ? changedFilesFromDiff(diff) : [];
  if (opts.workspace)
    opts.onEvent?.({ type: "final-diff", diff, changedFiles } as never);

  usage.totalTokens = usage.inputTokens + usage.outputTokens;

  return {
    text: finalText,
    steps,
    diff,
    changedFiles,
    usage,
    messages: transcript,
    ...(stopReason ? { stopReason } : {}),
  };
}
