import { stepCountIs, type ModelMessage } from "ai";
import { buildWorkspaceTools } from "./tools";
import type { RunCodingAgentOptions, RunCodingAgentResult } from "./types";

const DEFAULT_SYSTEM =
  "You are an expert software engineer working in a checked-out repository. " +
  "Use the provided tools to read, search, and edit files and run commands. " +
  "Make the smallest correct change that satisfies the request, run the repo's " +
  "tests or build when relevant, and stop when the task is complete.";

/** Parse `git diff` output for the set of changed file paths (`+++ b/<path>` headers). */
export function changedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const path = /^\+\+\+ b\/(.+)$/.exec(line)?.[1];
    if (path && path !== "/dev/null") files.add(path);
  }
  return [...files].sort();
}

/**
 * The coding loop. Runs a tool-using model turn against a `Workspace` until the
 * model stops or the step cap is hit, then returns the resulting diff + summary.
 *
 * The model call goes through the injected `AgentAi` port — never `streamText`
 * directly — so the same loop meters correctly on the platform and stays
 * BYOK/unmetered in the CLI (ADR-019).
 */
export async function runCodingAgent(opts: RunCodingAgentOptions): Promise<RunCodingAgentResult> {
  const onEvent = opts.onEvent ?? (() => undefined);
  const tools = buildWorkspaceTools(opts.workspace, {
    readOnly: opts.readOnly,
    codeGraph: opts.codeGraph,
    codeMap: opts.codeMap,
    onEvent,
  });

  const messages: ModelMessage[] = [
    ...(opts.history ?? []),
    { role: "user", content: opts.instruction },
  ];

  const recalled = opts.memory ? await opts.memory.recallContext().catch(() => "") : "";
  const system =
    (opts.system ?? DEFAULT_SYSTEM) +
    (recalled ? "\n\n## Recalled context (from prior sessions)\n" + recalled : "");

  let streamError: unknown = null;
  const result = opts.ai.stream({
    model: opts.model ?? "anthropic/claude-opus-4-8",
    system,
    messages,
    tools,
    stopWhen: stepCountIs(opts.maxSteps ?? 32),
    abortSignal: opts.signal,
    onError: ({ error }) => {
      streamError = error;
    },
    onStepFinish: ({ toolCalls }) => {
      for (const tc of toolCalls ?? []) {
        const call = tc as { toolName: string; input?: unknown; args?: unknown };
        onEvent({ type: "tool-call", name: call.toolName, input: call.input ?? call.args });
      }
    },
  });

  let text = "";
  try {
    for await (const delta of result.textStream) {
      text += delta;
      onEvent({ type: "text", delta });
    }
  } catch (err) {
    streamError ??= err;
  }
  if (streamError) throw streamError instanceof Error ? streamError : new Error(String(streamError));

  const steps = (await result.steps).length;
  const usage = await result.usage;
  const response = await result.response;

  const diff = await opts.workspace.diff();
  const changedFiles = changedFilesFromDiff(diff);
  onEvent({ type: "final-diff", diff, changedFiles });

  if (opts.memory)
    void Promise.resolve(
      opts.memory.remember("coding_turn", { instruction: opts.instruction, changedFiles }),
    ).catch(() => {});
  if (opts.trace)
    void Promise.resolve(
      opts.trace.record({ instruction: opts.instruction, changedFiles, steps, text, usage }),
    ).catch(() => {});

  return {
    text,
    steps,
    diff,
    changedFiles,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    },
    messages: [...messages, ...response.messages],
  };
}
