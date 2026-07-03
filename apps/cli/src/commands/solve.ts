/**
 * `oxagen solve` — best-of-N task solving with live visibility.
 *
 * Runs the task through N independent candidates (each in its own isolated
 * worktree via the ONE engine loop), judges them comparatively, and applies the
 * winning patch — showing the whole race live so the user sees the orchestration
 * working, not a frozen spinner.
 *
 *   oxagen solve "fix the failing auth test" -n 5 --verify "pnpm test:unit -- auth"
 *   oxagen solve "…" --models anthropic/claude-fable-5,openai/gpt-5   # diverse candidates
 *   oxagen solve "…" --json                                          # headless JSONL stream
 *   oxagen solve "…" --pipeline                                      # each candidate runs evaluate/enhance/judge too
 */
import { requireSession } from "../lib/session.js";
import { createGatewayAgentAi, createPlatformAgentAi } from "../agent/adapters/index.js";
import { createMeteredAi } from "../agent/metered-ai.js";
import { loadProjectContext } from "../agent/project-context.js";
import { launchBestOfN } from "../tui/best-of-n-view/index.js";
import { debugLog } from "../lib/debug-log.js";
import type { AgentAi } from "@oxagen/agent-engine";

export interface SolveOptions {
  candidates?: number;
  verify?: string;
  models?: string;
  selector?: string;
  model?: string;
  readonly?: boolean;
  json?: boolean;
  /**
   * Run every candidate through the full evaluate→enhance→route→execute→
   * judge→revise pipeline instead of the bare engine loop (default: bare —
   * the comparative selector across all N candidates already judges, so a
   * per-candidate judge too is normally redundant cost). Turns on the
   * semantic-enhance fallback (embeds the prompt, pulls related files from
   * the code graph before the candidate starts) and a per-candidate
   * completeness judge/revise round, at roughly N extra judge-class model
   * calls. See BestOfNOptions.fullPipeline.
   */
  pipeline?: boolean;
}

export async function handleSolve(prompt: string, opts: SolveOptions): Promise<void> {
  const session = requireSession();
  const cwd = process.cwd();

  const baseAi: AgentAi = session.synthetic
    ? createGatewayAgentAi({ cwd })
    : createPlatformAgentAi({
        apiUrl: session.apiUrl,
        token: session.token,
        orgSlug: session.orgSlug,
        workspaceSlug: session.workspaceSlug,
      });
  const ai = createMeteredAi(baseAi, { onLog: (line) => void debugLog("timeout", line) });

  const models = opts.models
    ? opts.models.split(",").map((s) => s.trim()).filter(Boolean)
    : opts.model
      ? [opts.model]
      : undefined;

  const candidates = Math.max(1, Math.min(opts.candidates ?? 3, 10));

  void debugLog("turn", "solve.start", { prompt, candidates, verify: opts.verify, models, pipeline: Boolean(opts.pipeline) });

  const result = await launchBestOfN({
    prompt,
    cwd,
    candidates,
    ai,
    models,
    selectorModel: opts.selector,
    verifyCommand: opts.verify,
    readOnly: opts.readonly,
    projectContext: loadProjectContext(cwd),
    headless: opts.json,
    fullPipeline: opts.pipeline,
  });

  // Exit non-zero when nothing viable was produced, so scripts can branch on it.
  if (!result.selection.winnerId) process.exitCode = 1;
}
