/**
 * One-shot mode — run a single prompt through the local agent loop, stream the
 * response to stdout, exit.
 *
 * Usage:
 *   oxagen "fix the login bug"
 *   oxagen --readonly "explain how auth works"
 *   echo "explain this code" | oxagen
 *
 * The agent operates on the current working directory using local coding tools,
 * loads project rules (CLAUDE.md/AGENTS.md), and records the turn into Oxagen's
 * context engine. Model calls go through the Vercel AI Gateway.
 */
import { runTurn, type AgentAi } from "@oxagen/agent-engine";
import {
  createCwdWorkspace,
  createGatedWorkspace,
  createCombinedMemory,
  createServerMemory,
  createCodeGraphProvider,
  createGraphSyncProvider,
  createPlatformAgentAi,
  createGatewayAgentAi,
} from "../agent/adapters/index.js";
import { resolveApiContext } from "../lib/api.js";
import { createMeteredAi } from "../agent/metered-ai.js";
import { queryCodeGraph } from "../agent/code-graph.js";
import type { Session } from "../lib/session.js";
import { runAgent } from "../agent/loop.js";
import { loadProjectContext } from "../agent/project-context.js";
import { openSessionMemory } from "../agent/memory.js";
import { openFleetMemory } from "../agent/fleet/memory.js";
import { openTraceStore } from "../agent/trace-store.js";
import { getAgent } from "../agents/loader.js";
import { appendVerboseLog } from "../agent/verbose-log.js";
import { formatVerboseSection } from "../agent/trace-format.js";
import { readConfig } from "../lib/config.js";
import { resolveEffort } from "../agent/model.js";
import { PermissionBroker, type PermissionMode } from "../agent/permissions.js";
import { loadSettings } from "../settings/resolve.js";
import { buildTurnExtras, type TurnExtras } from "../agent/turn-extras.js";
import { formatToolCall, formatToolCallWithSpacing } from "../agent/tool-formatter.js";
import { debugLog } from "../lib/debug-log.js";
import {
  makeTurnController,
  makeStallDetector,
  AgentTimeoutError,
  DEFAULT_TIMEOUTS,
} from "../agent/timeouts.js";

export interface OneShotOptions {
  /** Authenticated platform session (token, org, workspace). */
  session: Session;
  readOnly?: boolean;
  model?: string;
  /** Reasoning effort for models that support it (low|medium|high). */
  effort?: string;
  /**
   * Permission posture. One-shot is non-interactive, so there is no approver:
   * `ask` fails closed (mutations are denied), `acceptEdits` auto-allows file
   * edits, `bypass` allows everything. When unset, the run is ungated (the
   * historical scripted behavior).
   */
  mode?: PermissionMode;
  /** Skip the eval/enhance/judge pipeline and run the bare agent. */
  bare?: boolean;
  /** Capture + emit full per-turn telemetry (overrides config default). */
  verbose?: boolean;
  /**
   * stdout format. `text` (default) streams the answer; `json` prints ONE
   * result envelope at the end; `stream-json` prints JSONL events (stage /
   * tool / text / reasoning) as they happen, ending with the result envelope.
   * Both JSON modes keep stdout machine-pure — human progress stays on stderr
   * in `json` mode and is omitted in `stream-json` mode.
   */
  outputFormat?: "text" | "json" | "stream-json";
  /** Cap the agent tool loop at n steps per execution round (default 256). */
  maxSteps?: number;
}

export async function runOneShot(
  prompt: string,
  options: OneShotOptions,
): Promise<void> {
  const cwd = process.cwd();
  const projectContext = loadProjectContext(cwd);
  // OXAGEN_DISABLE_MEMORY=1 skips recall/remember entirely. Benchmark runs set
  // it so recalled context from one instance can never leak into another
  // (SWE-bench reuses the same repos across many instances).
  const memoryDisabled = process.env["OXAGEN_DISABLE_MEMORY"] === "1";
  const memory = memoryDisabled
    ? null
    : await openSessionMemory(cwd, `one-shot-${Date.now()}`);
  const fleetMemory = memoryDisabled ? null : openFleetMemory(cwd);
  // Platform memory: recall prior lessons + mirror new ones. Only when
  // authenticated (resolveApiContext non-null) and not a synthetic benchmark
  // session — a synthetic token can't authenticate, and bench runs must not leak
  // memory across instances (also gated by memoryDisabled below).
  const serverMemory =
    memoryDisabled || options.session.synthetic || !resolveApiContext()
      ? null
      : createServerMemory({
          agentId: "coding-agent",
          executionRef: `cli:one-shot-${Date.now()}`,
          projectName: cwd.split("/").pop() || undefined,
        });
  const traceStore = openTraceStore(cwd);
  const verbose = options.verbose ?? readConfig().verbose ?? false;

  // Engine ports for this invocation: local workspace, combined local memory,
  // the local code graph, and best-effort graph sync. Model calls route through
  // the platform (metered, session-authenticated) for real sessions, or
  // gateway-direct for the synthetic benchmark session — a synthetic token
  // cannot authenticate against /v1/agent/llm, and bench containers supply
  // AI_GATEWAY_API_KEY instead. Both are wrapped in the metered port so every
  // engine model call gets the per-call timeout + retry (Bug 1) that the REPL
  // path already has.
  const workspace = createCwdWorkspace(cwd);
  const baseAi: AgentAi = options.session.synthetic
    ? createGatewayAgentAi({ cwd })
    : createPlatformAgentAi({
        apiUrl: options.session.apiUrl,
        token: options.session.token,
        orgSlug: options.session.orgSlug,
        workspaceSlug: options.session.workspaceSlug,
      });
  const ai = createMeteredAi(baseAi, {
    onLog: (line) => void debugLog("timeout", line),
  });

  // Resolved settings.json for this turn — drives the broker's permissions, the
  // rule/hook/MCP extras, and the tool gate.
  const settings = loadSettings({ cwd }).settings;

  // Non-interactive: build a broker only when a mode is requested. With no
  // approver, `ask` denies mutations (fail closed); acceptEdits/bypass enable
  // scripted edits. The model-router never under-spends on safety regardless.
  const broker =
    options.mode && options.mode !== "readonly"
      ? new PermissionBroker({
          mode: options.mode,
          cwd,
          // Honor the same settings.json allow/deny lists the interactive REPL
          // uses: a `Bash(*)` allow lets scripted shell commands run without an
          // approver (which would otherwise fail closed), while a matching deny
          // still blocks the call.
          permissions: settings.permissions,
        })
      : undefined;
  const readOnly = options.readOnly || options.mode === "readonly";

  // Bound the non-interactive turn by PROGRESS, not by a wall clock (Bug 1):
  // there is NO per-turn time cap, so a long but healthy scripted/CI run
  // completes. The inactivity guard aborts only if no progress — a stream delta,
  // stage, or tool call — lands within turnInactivityMs. Esc is not available
  // here, so this progress guard is the only backstop against a truly hung turn.
  //
  // A tool that is EXECUTING is progress, even though no events arrive until it
  // finishes: a real test suite legitimately runs longer than the guard window
  // (bash allows up to 600s; the window is 300s). Every engine tool carries its
  // own timeout backstop, so an in-flight tool ALWAYS returns — when the guard
  // fires mid-tool it defers instead of killing a healthy run.
  const inactivityMs = DEFAULT_TIMEOUTS.turnInactivityMs ?? 300_000;
  const turnController = makeTurnController();
  let inFlightTools = 0;
  const stall = makeStallDetector(inactivityMs, () => {
    if (inFlightTools > 0) {
      stall.reset(); // a tool is executing (bounded by its own timeout) — defer
      return;
    }
    if (!turnController.signal.aborted) {
      void debugLog("timeout", "[timeout] scope=turn reason=inactivity");
      turnController.abort(new AgentTimeoutError("turn inactivity", inactivityMs));
    }
  });

  void debugLog("turn", "turn.start", { mode: "one-shot", readOnly, model: options.model, prompt });

  // Output routing. `text` streams the answer to stdout; the JSON modes keep
  // stdout machine-pure: `json` emits ONE result envelope at the end, and
  // `stream-json` emits JSONL events as they happen plus the final envelope.
  const format = options.outputFormat ?? "text";
  const emitJson = (obj: unknown): void => {
    process.stdout.write(JSON.stringify(obj) + "\n");
  };

  // System-prompt profile: an explicit OXAGEN_PROMPT_PROFILE wins; otherwise a
  // non-TTY stdout (piped one-shot, SWE-bench, CI) selects the terse "headless"
  // verification profile, while an interactive TTY leaves it undefined so the
  // engine's default narrating "interactive" profile applies.
  const promptProfile: "interactive" | "headless" | undefined =
    process.env["OXAGEN_PROMPT_PROFILE"] === "interactive"
      ? "interactive"
      : process.env["OXAGEN_PROMPT_PROFILE"] === "headless" || !process.stdout.isTTY
        ? "headless"
        : undefined;

  // Workspace rules (Tier 1 prompt + Tier 2 gate denies), SessionStart/Pre/Post
  // hooks, and external MCP tools — assembled into the engine's extraTools /
  // wrapTools seams so the primary one-shot path runs the ONE engine loop with
  // the same wiring the legacy loop had. Permissions stay with the broker
  // (gatePermissions:false), so this gate adds only rule-guard denies + hooks —
  // no double-gating.
  const extras: TurnExtras = await buildTurnExtras({
    cwd,
    settings,
    readOnly,
    gatePermissions: false,
    signal: turnController.signal,
    onBlocked: (name, reason) => {
      void debugLog("turn", "turn.tool-blocked", { name, reason });
      process.stderr.write(`  ⛔ ${name}: ${reason}\n`);
    },
    onMcpServer: (s) =>
      void debugLog("turn", "mcp.server", s as unknown as Record<string, unknown>),
  });
  // Fold the rules + session-start context into what the model sees as project rules.
  const enrichedContext = extras.systemAppend
    ? {
        text: (projectContext?.text ?? "") + extras.systemAppend,
        sources: [...(projectContext?.sources ?? []), "workspace rules + hooks"],
      }
    : projectContext;

  try {
    let streamed = false;
    const result = await runTurn({
      prompt,
      workspace: createGatedWorkspace(workspace, broker),
      ai,
      projectContext: enrichedContext,
      extraTools: extras.extraTools,
      wrapTools: extras.wrapTools,
      readOnly,
      profile: promptProfile,
      model: options.model,
      bare: options.bare,
      verbose,
      maxSteps: options.maxSteps,
      memory: createCombinedMemory(memory, fleetMemory, {
        server: serverMemory,
        recallQuery: prompt,
      }),
      codeGraph: createCodeGraphProvider((op, q, l) => queryCodeGraph(cwd, op, q, l)),
      trace: traceStore,
      // Graph sync posts to the platform API — meaningless (and unauthenticated)
      // for the synthetic benchmark session, so skip it entirely there.
      graphSync: options.session.synthetic
        ? null
        : createGraphSyncProvider({ ...options.session, cwd }),
      effort: resolveEffort(options.effort),
      signal: turnController.signal,
      // Pipeline stage progress goes to stderr so stdout stays the clean answer.
      onStage: (stage) => {
        stall.reset();
        void debugLog("turn", "turn.stage", { label: stage.label, detail: stage.detail });
        if (format === "stream-json") {
          emitJson({ type: "stage", label: stage.label, detail: stage.detail });
        } else {
          process.stderr.write(
            `  ${stage.label}${stage.detail ? ` · ${stage.detail}` : ""}\n`,
          );
        }
      },
      onText: (delta) => {
        stall.reset();
        streamed = true;
        if (format === "text") process.stdout.write(delta);
        else if (format === "stream-json") emitJson({ type: "text", delta });
        // json: silent — the full text rides in the final envelope.
      },
      // Reasoning / chain-of-thought goes to stderr (dim), so the piped stdout
      // stays the clean answer while the thinking is still visible on a TTY.
      onReasoning: (delta) => {
        stall.reset();
        if (format === "stream-json") emitJson({ type: "reasoning", delta });
        else process.stderr.write(`\x1b[2m${delta}\x1b[22m`);
      },
      // Tool activity goes to stderr so stdout stays the clean final answer
      // (pipeable). e.g. `oxagen "..." > out.md` captures only the answer.
      onToolCall: (name, input) => {
        inFlightTools++;
        stall.reset();
        void debugLog("turn", "turn.tool-call", { name, input });
        if (format === "stream-json") {
          emitJson({ type: "tool", phase: "start", name });
        } else {
          process.stderr.write(formatToolCallWithSpacing(name, input));
        }
      },
      onToolEvent: ({ name, ok, durationMs }) => {
        inFlightTools = Math.max(0, inFlightTools - 1);
        stall.reset();
        void debugLog("turn", "turn.tool-result", { name, ok, durationMs });
        if (format === "stream-json") {
          emitJson({ type: "tool", phase: "end", name, ok, durationMs });
        }
      },
    });
    if (format === "text") {
      if (streamed) process.stdout.write("\n");
    } else {
      // One machine-readable result envelope, shared by json and stream-json.
      emitJson({
        type: "result",
        ok: true,
        text: result.text,
        steps: result.steps,
        usage: result.usage,
        model: result.trace.selectedModel,
        filesTouched: result.trace.filesTouched,
        commandsRun: result.trace.commandsRun,
        complete: result.trace.finalComplete,
        traceId: result.trace.id,
        durationMs: result.trace.durationMs,
      });
    }
    void debugLog("turn", "turn.end", { mode: "one-shot", streamed, format });
    // The engine persists the trace via the injected `trace` port. Verbose mode
    // additionally appends the structured record to the JSONL stream and prints
    // the per-phase / per-model / cost breakdown to stderr (stdout stays the
    // clean answer).
    if (verbose) {
      appendVerboseLog(cwd, result.trace);
      process.stderr.write(formatVerboseSection(result.trace).join("\n") + "\n");
    }
  } catch (err) {
    // A timeout/stall aborts turnController with a typed AgentTimeoutError whose
    // message is already user-facing; surface it verbatim rather than as a raw
    // AbortError from the AI SDK.
    const reason: unknown = turnController.signal.aborted
      ? turnController.signal.reason
      : undefined;
    const message =
      reason instanceof AgentTimeoutError
        ? reason.message
        : err instanceof Error
          ? err.message
          : String(err);
    void debugLog("error", "turn.error", { mode: "one-shot", message });
    if (format !== "text") {
      emitJson({ type: "result", ok: false, error: message });
    }
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  } finally {
    stall.stop();
    await extras.closeMcp();
    await memory?.close();
  }
}

/**
 * Run a single prompt as a named agent (its system prompt, tool allowlist, and
 * model). Bypasses the eval/enhance/judge pipeline — the agent's own prompt is
 * authoritative. Streams the answer to stdout; tool activity to stderr.
 */
export async function runAgentOneShot(
  prompt: string,
  agentName: string,
  options: OneShotOptions,
): Promise<void> {
  const cwd = process.cwd();
  const agent = getAgent(agentName, { cwd });
  if (!agent) {
    process.stderr.write(`Error: unknown agent "${agentName}". Run \`oxagen agent list\`.\n`);
    process.exitCode = 1;
    return;
  }
  const projectContext = loadProjectContext(cwd);
  // Combined memory so a named agent (e.g. break-fix) recalls prior-session
  // lessons before it acts and mirrors high-signal lessons after — the same
  // wiring the main coding path uses. Degrades to local-only when logged out /
  // synthetic, and is fully skipped under OXAGEN_DISABLE_MEMORY=1.
  const memoryDisabled = process.env["OXAGEN_DISABLE_MEMORY"] === "1";
  const memory = memoryDisabled
    ? null
    : await openSessionMemory(cwd, `agent-${agentName}-${Date.now()}`);
  const fleetMemory = memoryDisabled ? null : openFleetMemory(cwd);
  const serverMemory =
    memoryDisabled || options.session.synthetic || !resolveApiContext()
      ? null
      : createServerMemory({
          agentId: agentName,
          executionRef: `cli:agent-${agentName}-${Date.now()}`,
          projectName: cwd.split("/").pop() || undefined,
        });
  try {
    let streamed = false;
    await runAgent({
      prompt,
      cwd,
      agent,
      readOnly: options.readOnly,
      model: options.model,
      maxSteps: options.maxSteps,
      projectContext,
      memory: createCombinedMemory(memory, fleetMemory, {
        server: serverMemory,
        recallQuery: prompt,
      }),
      onText: (delta) => {
        streamed = true;
        process.stdout.write(delta);
      },
      // Reasoning to stderr (dim) so piped stdout stays the clean answer.
      onReasoning: (delta) => process.stderr.write(`\x1b[2m${delta}\x1b[22m`),
      onToolCall: (name, input) => {
        process.stderr.write(`  · ${formatToolCall(name, input)}\n`);
      },
      onToolBlocked: (name, reason) => process.stderr.write(`  ⛔ ${name}: ${reason}\n`),
    });
    if (streamed) process.stdout.write("\n");
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    await memory?.close();
  }
}

export async function runFromStdin(options: OneShotOptions): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const prompt = Buffer.concat(chunks).toString("utf8").trim();
  if (!prompt) {
    process.stderr.write("Error: No input received on stdin.\n");
    process.exitCode = 1;
    return;
  }
  await runOneShot(prompt, options);
}
