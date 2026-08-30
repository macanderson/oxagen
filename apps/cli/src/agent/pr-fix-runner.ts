/**
 * The real {@link FixRunner} backing `oxagen pr fix` — ONE bounded engine-agent
 * turn, built the same way `repl/one-shot.ts` builds its AI and calls
 * {@link runTurn}: the session-routed `ai` (metered platform calls for a real
 * session, gateway-direct for the synthetic benchmark session), the code
 * graph, and platform memory recall/mirror (the convention every CLI agent
 * path follows — see `apps/cli/src/agent/adapters/memory-provider.ts`).
 *
 * Scoped down from a full one-shot turn on purpose:
 *   - `bare: true` — skip the eval/enhance/judge pipeline. The prompt is
 *     already a precise, single-purpose instruction (the failing check's
 *     error); `pr-fix.ts`'s own round loop is what decides whether to try
 *     again, not an internal judge.
 *   - `acceptEdits`, no approver — file edits are auto-allowed (that's the
 *     whole point), but `bash` always resolves to "ask" with nobody to ask,
 *     so it fails closed. This loop runs unattended: it must never execute
 *     arbitrary shell commands on the model's say-so. Verification happens by
 *     re-running real CI, not by trusting the model's own test run.
 *   - a fresh, bounded `maxSteps` and the same inactivity-stall backstop
 *     `one-shot.ts` uses, since a hang here would wedge the whole fix loop.
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
  type ServerMemory,
} from "./adapters/index.js";
import { createMeteredAi } from "./metered-ai.js";
import { queryCodeGraph } from "./code-graph.js";
import { PermissionBroker } from "./permissions.js";
import { resolveApiContext } from "../lib/api.js";
import { debugLog } from "../lib/debug-log.js";
import { loadSettings } from "../settings/resolve.js";
import { formatToolCallWithSpacing } from "./tool-formatter.js";
import { createTurnRunner, resolveTurnInactivityMs } from "./timeouts.js";
import type { FixRunner, FixTurnResult } from "../lib/pr-fix.js";
import type { Session } from "../lib/session.js";

/** Per-turn tool-loop cap. Small on purpose — one bounded diagnose-and-edit pass, not an open-ended session. */
const FIX_TURN_MAX_STEPS = 40;

export interface CreatePrFixRunnerOptions {
  session: Session;
  cwd: string;
  model?: string;
  /** Named-agent-style identifier stamped on recalled/mirrored memories. */
  memoryExecutionRef: string;
}

export interface PrFixRunnerHandle {
  runFixer: FixRunner;
  /** Mirror a lesson about this loop's final outcome. Best-effort; no-op when not authenticated. */
  rememberOutcome: (
    kind: string,
    detail: { lesson: string; files: string[] },
  ) => void;
}

/** Build the real, engine-backed fixer + its memory mirror for `oxagen pr fix`. */
export function createPrFixRunner(
  opts: CreatePrFixRunnerOptions,
): PrFixRunnerHandle {
  const { session, cwd } = opts;

  const baseAi: AgentAi = session.synthetic
    ? createGatewayAgentAi({ cwd })
    : createPlatformAgentAi({
        apiUrl: session.apiUrl,
        token: session.token,
        orgSlug: session.orgSlug,
        workspaceSlug: session.workspaceSlug,
      });
  const ai = createMeteredAi(baseAi, {
    onLog: (line) => void debugLog("timeout", line),
  });

  const settings = loadSettings({ cwd }).settings;
  // acceptEdits + no approver: file edits auto-allow, bash fails closed (see module docblock).
  const broker = new PermissionBroker({
    mode: "acceptEdits",
    cwd,
    permissions: settings.permissions,
  });
  const workspace = createGatedWorkspace(createCwdWorkspace(cwd), broker);
  const codeGraph = createCodeGraphProvider((op, q, l) =>
    queryCodeGraph(cwd, op, q, l),
  );

  // Platform memory: recall prior lessons for this workspace before diagnosing,
  // mirror the outcome after. Only when authenticated and not the synthetic
  // benchmark session (mirrors one-shot.ts's gate exactly).
  const serverMemory: ServerMemory | null =
    !session.synthetic && resolveApiContext()
      ? createServerMemory({
          agentId: "pr-fix",
          executionRef: opts.memoryExecutionRef,
          projectName: cwd.split("/").pop() || undefined,
        })
      : null;

  const profile: "headless" | undefined = process.stdout.isTTY
    ? undefined
    : "headless";

  const runFixer: FixRunner = async (
    prompt: string,
  ): Promise<FixTurnResult> => {
    // No CI probe here: the fix loop's own poller (lib/pr-fix.ts waitForTerminal)
    // does the CI waiting OUTSIDE these turns; a fixer turn itself should never
    // sit silent — the runner's default shouldDefer (in-flight tool count > 0)
    // defers while a tool executes.
    const runner = createTurnRunner({
      turnInactivityMs: resolveTurnInactivityMs(),
    });

    try {
      const result = await runTurn({
        prompt,
        workspace,
        ai,
        readOnly: false,
        bare: true,
        profile,
        model: opts.model,
        maxSteps: FIX_TURN_MAX_STEPS,
        codeGraph,
        memory: createCombinedMemory(null, null, {
          server: serverMemory,
          recallQuery: prompt,
        }),
        signal: runner.signal,
        onText: () => runner.noteProgress(),
        onToolCall: (name, input) => {
          runner.noteToolStart();
          runner.noteProgress();
          process.stderr.write(formatToolCallWithSpacing(name, input));
        },
        onToolEvent: () => {
          runner.noteToolEnd();
          runner.noteProgress();
        },
      });
      return { text: result.text };
    } finally {
      runner.stop();
    }
  };

  return {
    runFixer,
    rememberOutcome: (kind, detail) => {
      if (!detail.lesson.trim()) return;
      serverMemory?.remember(kind, detail);
    },
  };
}
