/**
 * The fleet's default {@link AgentRunner}, backed by the ONE engine loop.
 *
 * A fleet subagent used to run the legacy `agent/loop.ts` loop; this runner
 * gives it the SAME engine `runTurn` the REPL and one-shot use — so the whole
 * CLI has a single coding loop (retry, compaction, loop-detection, the hardened
 * tools) instead of two. It preserves the legacy runner's behaviour: BYOK
 * gateway-direct model calls (the fleet is unmetered), the agent persona as the
 * system identity, `bare` execution (the fleet runs its OWN judge/plan loop
 * around each subagent, so a per-subagent pipeline would double up), and the
 * rules/hooks/MCP + tool-gate wiring assembled by {@link buildTurnExtras}.
 *
 * The fleet has no interactive permission broker, so the tool gate owns
 * permissions here (`gatePermissions: true`).
 */
import { runTurn } from "@oxagen/agent-engine";
import { createCwdWorkspace, createCodeGraphProvider, createGatewayAgentAi } from "./adapters/index.js";
import { createMeteredAi } from "./metered-ai.js";
import { queryCodeGraph } from "./code-graph.js";
import { buildTurnExtras } from "./turn-extras.js";
import { loadSettings } from "../settings/resolve.js";
import { debugLog } from "../lib/debug-log.js";
import type { AgentRunner } from "./fleet/orchestrator.js";

/** Build the engine-backed fleet runner. */
export function createEngineRunner(): AgentRunner {
  return async (opts) => {
    const cwd = opts.cwd;
    const ai = createMeteredAi(createGatewayAgentAi({ cwd }), {
      onLog: (line) => void debugLog("timeout", line),
    });
    const settings = loadSettings({ cwd }).settings;
    const extras = await buildTurnExtras({
      cwd,
      settings,
      readOnly: opts.readOnly,
      agentTools: opts.agent?.tools,
      gatePermissions: true,
      signal: opts.signal,
      onBlocked: (name, reason) =>
        void debugLog("turn", "fleet.tool-blocked", { name, reason }),
    });
    const enrichedContext = extras.systemAppend
      ? {
          text: (opts.projectContext?.text ?? "") + extras.systemAppend,
          sources: [...(opts.projectContext?.sources ?? []), "workspace rules + hooks"],
        }
      : opts.projectContext;

    try {
      const result = await runTurn({
        prompt: opts.prompt,
        workspace: createCwdWorkspace(cwd),
        ai,
        projectContext: enrichedContext,
        extraTools: extras.extraTools,
        wrapTools: extras.wrapTools,
        agent: opts.agent
          ? { name: opts.agent.name, systemPrompt: opts.agent.systemPrompt }
          : undefined,
        bare: true,
        readOnly: opts.readOnly,
        model: opts.model ?? opts.agent?.model,
        codeGraph: createCodeGraphProvider((op, q, l) => queryCodeGraph(cwd, op, q, l)),
        memory: opts.memory ?? undefined,
        signal: opts.signal,
        onText: opts.onText,
        onToolCall: opts.onToolCall,
      });
      return {
        text: result.text,
        steps: result.steps,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
      };
    } finally {
      await extras.closeMcp();
    }
  };
}
