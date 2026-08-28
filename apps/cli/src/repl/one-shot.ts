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
  createPlatformAgentAi,
  createGatewayAgentAi,
} from "../agent/adapters/index.js";
import { resolveApiContext } from "../lib/api.js";
import { createMeteredAi } from "../agent/metered-ai.js";
import { queryCodeGraph } from "../agent/code-graph.js";
import type { Session } from "../lib/session.js";
import { loadProjectContext } from "../agent/project-context.js";
import { openSessionMemory } from "../agent/memory.js";
import { openFleetMemory } from "../agent/fleet/memory.js";
import { openTraceStore } from "../agent/trace-store.js";
import { getAgent } from "../agents/loader.js";
import { appendVerboseLog } from "../agent/verbose-log.js";
import { formatVerboseSection } from "../agent/trace-format.js";
import { readConfig } from "../lib/config.js";
import { resolveEffort, resolveModelId } from "../agent/model.js";
import {
  createTurnBudgetGuard,
  formatBudgetUsd,
  TURN_BUDGET_MODES,
  type TurnBudgetPolicy,
  type TurnBudgetVerdict,
} from "@oxagen/billing/turn-budget";
import { PermissionBroker, type PermissionMode } from "../agent/permissions.js";
import { loadSettings } from "../settings/resolve.js";
import { buildTurnExtras, type TurnExtras } from "../agent/turn-extras.js";
import {
  formatToolCall,
  formatToolCallWithSpacing,
} from "../agent/tool-formatter.js";
import { formatActivityLine } from "../tui/activity.js";
import { debugLog } from "../lib/debug-log.js";
import {
  createTurnRunner,
  AgentTimeoutError,
  resolveTurnInactivityMs,
} from "../agent/timeouts.js";
import { createCiWaitProbe } from "../lib/ci-wait.js";

export interface OneShotOptions {
  /** Authenticated platform session (token, org, workspace). */
  session: Session;
  readOnly?: boolean;
  /** Worker (executor) model. */
  model?: string;
  /** Judge (completeness advisor) model. Undefined ⇒ engine default advisor tier. */
  judgeModel?: string;
  /** Triage/coordinator (planner + evaluator) model. Undefined ⇒ engine default. */
  triageModel?: string;
  /** Reasoning effort for models that support it (low|medium|high|xhigh|max). */
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
  /**
   * Per-turn dollar budget (from `--budget`/`--budget-mode`), session-scoped —
   * no platform persistence. Undefined ⇒ unbounded. `mode: "prompt"` cannot ask
   * interactively here (no TTY / no approver) — see {@link buildBudgetGuard}.
   */
  budget?: TurnBudgetPolicy;
}

/**
 * Build the engine's per-turn budget guard for a NON-interactive run (one-shot,
 * `--agent`, stdin). There is no interactive overlay here, so the three modes
 * degrade as follows:
 *   - "grace"   — same as everywhere: keep going within the cushion, warn once.
 *   - "prompt"  — cannot ask a human; treated as a HARD STOP (same as
 *                 "enforce") so a scripted/CI run never hangs waiting on input
 *                 that will never arrive.
 *   - "enforce" — hard stop, as designed.
 * Returns undefined when the policy is off (createTurnBudgetGuard's own check).
 */
function buildBudgetGuard(
  policy: TurnBudgetPolicy | undefined,
  model: string,
): ReturnType<typeof createTurnBudgetGuard> {
  if (!policy) return undefined;
  let graceWarned = false;
  return createTurnBudgetGuard(policy, model, {
    onWithinGrace: (verdict: TurnBudgetVerdict) => {
      if (graceWarned) return;
      graceWarned = true;
      process.stderr.write(
        `⚠︎ Over budget — within grace window (${formatBudgetUsd(verdict.costUsd)} / ` +
          `ceiling ${formatBudgetUsd(verdict.ceilingUsd)}).\n`,
      );
    },
    // Headless: "prompt" mode has no one to ask. Stop instead of hanging, and
    // tell the user how to get a bigger window on the next run.
    onPause: () => false,
    onStop: (verdict: TurnBudgetVerdict) => {
      const modeLabel = TURN_BUDGET_MODES[verdict.mode].label;
      const note =
        verdict.mode === "prompt"
          ? " (prompt mode can't ask interactively in one-shot — raise --budget and rerun)"
          : "";
      process.stderr.write(
        `⛔ Per-turn budget reached — stopped at ${formatBudgetUsd(verdict.costUsd)} of ` +
          `${formatBudgetUsd(verdict.limitUsd)} (${modeLabel}).${note}\n`,
      );
    },
  });
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
  // AI_GATEWAY_API_KEY (or ANTHROPIC_API_KEY for Anthropic-only BYOK) instead.
  // Both are wrapped in the metered port so every
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
  // fires mid-tool it defers instead of killing a healthy run. Before aborting
  // it also makes one CI call-out: a turn that was watching still-pending
  // checks keeps waiting (capped at resolveCiWaitCapMs(), 2h default).
  const inactivityMs = resolveTurnInactivityMs();
  const ciProbe = createCiWaitProbe(cwd);
  const runner = createTurnRunner(
    { turnInactivityMs: inactivityMs },
    {
      onLog: (line) => void debugLog("timeout", line),
      stall: { probe: () => ciProbe.probe() },
    },
  );

  void debugLog("turn", "turn.start", {
    mode: "one-shot",
    readOnly,
    model: options.model,
    prompt,
  });

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
      : process.env["OXAGEN_PROMPT_PROFILE"] === "headless" ||
          !process.stdout.isTTY
        ? "headless"
        : undefined;

  // Workspace rules (Tier 1 prompt + Tier 2 gate denies), SessionStart/Pre/Post
  // hooks, and external MCP tools — assembled into the engine's extraTools /
  // wrapTools seams so the primary one-shot path runs the ONE engine loop.
  // Permissions stay with the broker (gatePermissions:false), so this gate
  // adds only rule-guard denies + hooks — no double-gating.
  const extras: TurnExtras = await buildTurnExtras({
    cwd,
    settings,
    readOnly,
    gatePermissions: false,
    signal: runner.signal,
    onBlocked: (name, reason) => {
      void debugLog("turn", "turn.tool-blocked", { name, reason });
      process.stderr.write(`  ⛔ ${name}: ${reason}\n`);
    },
    onMcpServer: (s) =>
      void debugLog(
        "turn",
        "mcp.server",
        s as unknown as Record<string, unknown>,
      ),
  });
  // Fold the rules + session-start context into what the model sees as project rules.
  const enrichedContext = extras.systemAppend
    ? {
        text: (projectContext?.text ?? "") + extras.systemAppend,
        sources: [
          ...(projectContext?.sources ?? []),
          "workspace rules + hooks",
        ],
      }
    : projectContext;

  // Headless enhance budget: on a cold store the first code-graph query
  // triggers a full tree-sitter build (135s+ on a Django-sized repo — measured
  // on SWE-bench), so the ENHANCE stage must not block on it. Warm the graph in
  // the background NOW so the build overlaps the evaluate stage and the coding
  // loop; the agent's own `code_graph` tool calls hit the warmed cache.
  // OXAGEN_ENHANCE_TIMEOUT_MS overrides (0 disables the bound).
  const enhanceTimeoutRaw = Number(process.env["OXAGEN_ENHANCE_TIMEOUT_MS"]);
  const enhanceTimeoutMs = Number.isFinite(enhanceTimeoutRaw)
    ? enhanceTimeoutRaw > 0
      ? enhanceTimeoutRaw
      : undefined
    : promptProfile === "headless"
      ? 15_000
      : undefined;
  if (promptProfile === "headless" && !options.bare) {
    void queryCodeGraph(cwd, "search", "__graph_warmup__", 1).catch(() => {});
  }

  // Mid-session completeness check: in headless/bench mode, default to judging
  // after the first 20 steps so missing acceptance criteria are caught before the
  // agent burns the remaining budget on redundant verification loops.
  // OXAGEN_MID_JUDGE_STEPS overrides (0 disables). Controlled by the pipeline
  // option OR the env var (pipeline reads OXAGEN_MID_JUDGE_STEPS directly).
  const midJudgeStepsRaw = Number(process.env["OXAGEN_MID_JUDGE_STEPS"]);
  const midJudgeSteps =
    Number.isFinite(midJudgeStepsRaw) && midJudgeStepsRaw > 0
      ? midJudgeStepsRaw
      : promptProfile === "headless" && !options.bare
        ? 20
        : 0;

  // Per-turn dollar budget: priced against the model this run actually uses
  // (resolveModelId mirrors the fallback chain runTurn/the engine applies when
  // options.model is undefined, so the guard never prices against "undefined").
  const budgetGuard = buildBudgetGuard(
    options.budget,
    resolveModelId(options.model),
  );

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
      judgeModels: options.judgeModel ? [options.judgeModel] : undefined,
      triageModel: options.triageModel,
      bare: options.bare,
      verbose,
      maxSteps: options.maxSteps,
      budgetGuard,
      enhanceTimeoutMs,
      midJudgeSteps: midJudgeSteps > 0 ? midJudgeSteps : undefined,
      memory: createCombinedMemory(memory, fleetMemory, {
        server: serverMemory,
        recallQuery: prompt,
      }),
      codeGraph: createCodeGraphProvider((op, q, l) =>
        queryCodeGraph(cwd, op, q, l),
      ),
      trace: traceStore,
      effort: resolveEffort(options.effort),
      signal: runner.signal,
      // Pipeline stage progress goes to stderr so stdout stays the clean answer.
      onStage: (stage) => {
        runner.noteProgress();
        void debugLog("turn", "turn.stage", {
          label: stage.label,
          detail: stage.detail,
        });
        if (format === "stream-json") {
          emitJson({ type: "stage", label: stage.label, detail: stage.detail });
        } else {
          process.stderr.write(`  ${formatActivityLine(stage)}\n`);
        }
      },
      onText: (delta) => {
        runner.noteProgress();
        streamed = true;
        if (format === "text") process.stdout.write(delta);
        else if (format === "stream-json") emitJson({ type: "text", delta });
        // json: silent — the full text rides in the final envelope.
      },
      // Reasoning / chain-of-thought goes to stderr (dim), so the piped stdout
      // stays the clean answer while the thinking is still visible on a TTY.
      onReasoning: (delta) => {
        runner.noteProgress();
        if (format === "stream-json") emitJson({ type: "reasoning", delta });
        else process.stderr.write(`\x1b[2m${delta}\x1b[22m`);
      },
      // Tool activity goes to stderr so stdout stays the clean final answer
      // (pipeable). e.g. `oxagen "..." > out.md` captures only the answer.
      onToolCall: (name, input) => {
        runner.noteToolStart();
        ciProbe.noteToolCall(name, input);
        runner.noteProgress();
        void debugLog("turn", "turn.tool-call", { name, input });
        if (format === "stream-json") {
          emitJson({ type: "tool", phase: "start", name });
        } else {
          process.stderr.write(formatToolCallWithSpacing(name, input));
        }
      },
      onToolEvent: ({ name, ok, durationMs }) => {
        runner.noteToolEnd();
        runner.noteProgress();
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
      process.stderr.write(
        formatVerboseSection(result.trace).join("\n") + "\n",
      );
    }
  } catch (err) {
    // A timeout/stall aborts turnController with a typed AgentTimeoutError whose
    // message is already user-facing; surface it verbatim rather than as a raw
    // AbortError from the AI SDK.
    const reason: unknown = runner.signal.aborted
      ? runner.signal.reason
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
    runner.stop();
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
    process.stderr.write(
      `Error: unknown agent "${agentName}". Run \`oxagen agent list\`.\n`,
    );
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
  // Route the named agent through the ONE engine loop (runTurn): the persona's
  // systemPrompt replaces the default identity, `bare: true` makes it
  // authoritative (no eval/enhance/judge), and its tool allowlist + permissions
  // are enforced via the shared turn-extras gate. --agent has no interactive
  // broker, so the gate owns permissions (gatePermissions: true).
  const settings = loadSettings({ cwd }).settings;
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
  // Same progress guard as runOneShot: headless has no Esc, so this is the only
  // backstop against a hung turn. Defers while a tool executes; probes CI
  // before aborting a turn that was watching still-pending checks.
  const inactivityMs = resolveTurnInactivityMs();
  const ciProbe = createCiWaitProbe(cwd);
  const runner = createTurnRunner(
    { turnInactivityMs: inactivityMs },
    {
      onLog: (line) => void debugLog("timeout", line),
      stall: { probe: () => ciProbe.probe() },
    },
  );
  const extras = await buildTurnExtras({
    cwd,
    settings,
    readOnly: options.readOnly,
    agentTools: agent.tools,
    // Per-agent skill instructions + MCP-server selection —
    // AgentDefinition.skills / .mcpServers, parsed by agents/loader.ts.
    agentSkills: agent.skills,
    agentMcpServers: agent.mcpServers,
    gatePermissions: true,
    signal: runner.signal,
    onBlocked: (name, reason) =>
      process.stderr.write(`  ⛔ ${name}: ${reason}\n`),
  });
  const enrichedContext = extras.systemAppend
    ? {
        text: (projectContext?.text ?? "") + extras.systemAppend,
        sources: [
          ...(projectContext?.sources ?? []),
          "workspace rules + hooks",
        ],
      }
    : projectContext;

  // Per-turn dollar budget — same headless degrade as runOneShot (see
  // buildBudgetGuard): "prompt" mode can't ask interactively here either.
  // resolveModelId covers the same fallback chain as `model` below so the
  // guard always prices against a concrete slug, never undefined.
  const budgetGuard = buildBudgetGuard(
    options.budget,
    resolveModelId(options.model ?? agent.model),
  );

  try {
    let streamed = false;
    await runTurn({
      prompt,
      workspace: createCwdWorkspace(cwd),
      ai,
      projectContext: enrichedContext,
      extraTools: extras.extraTools,
      wrapTools: extras.wrapTools,
      agent: { name: agent.name, systemPrompt: agent.systemPrompt },
      bare: true,
      readOnly: options.readOnly,
      model: options.model ?? agent.model,
      maxSteps: options.maxSteps,
      budgetGuard,
      effort: resolveEffort(options.effort),
      memory: createCombinedMemory(memory, fleetMemory, {
        server: serverMemory,
        recallQuery: prompt,
      }),
      codeGraph: createCodeGraphProvider((op, q, l) =>
        queryCodeGraph(cwd, op, q, l),
      ),
      trace: openTraceStore(cwd),
      signal: runner.signal,
      onText: (delta) => {
        runner.noteProgress();
        streamed = true;
        process.stdout.write(delta);
      },
      // Reasoning to stderr (dim) so piped stdout stays the clean answer.
      onReasoning: (delta) => {
        runner.noteProgress();
        process.stderr.write(`\x1b[2m${delta}\x1b[22m`);
      },
      onToolCall: (name, input) => {
        runner.noteToolStart();
        ciProbe.noteToolCall(name, input);
        runner.noteProgress();
        process.stderr.write(`  · ${formatToolCall(name, input)}\n`);
      },
      onToolEvent: () => {
        runner.noteToolEnd();
        runner.noteProgress();
      },
    });
    if (streamed) process.stdout.write("\n");
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  } finally {
    runner.stop();
    await extras.closeMcp();
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
