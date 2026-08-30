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
import {
  createGatewayAgentAi,
  createPlatformAgentAi,
} from "../agent/adapters/index.js";
import { createMeteredAi } from "../agent/metered-ai.js";
import { createSolveUsageAccumulator } from "../agent/solve-usage.js";
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
   * judge→revise pipeline instead of the bare engine loop. Turns on the
   * semantic-enhance fallback (embeds the prompt, pulls related files from
   * the persisted code graph before the candidate starts) and a per-candidate
   * completeness judge/revise round, on top of the comparative selector that
   * still picks the winner across all N afterward — each candidate is
   * self-improved BEFORE comparison, not instead of it. Roughly N extra
   * judge-class model calls (one per candidate) plus N evaluate/enhance
   * calls, on top of what bare mode already costs. Undefined here defers to
   * `OXAGEN_BEST_OF_N_PIPELINE` (env `"1"` ⇒ on); neither set ⇒ bare, the
   * cheaper default. See BestOfNOptions.fullPipeline.
   */
  pipeline?: boolean;
  /**
   * Auto-detect verification: union the test/lint/build commands every
   * candidate actually ran during its own turn, then re-run that whole union
   * in EVERY surviving candidate's worktree before selection — so the
   * comparative selector gets a real, executed-test signal across the whole
   * pool instead of whatever subset of tests each candidate happened to run
   * on its own. Undefined here defers to `OXAGEN_BEST_OF_N_VERIFY` (env "1"
   * means on); neither set means off. See BestOfNOptions.verifyAuto.
   */
  verifyAuto?: boolean;
}

/**
 * Whether every candidate should run the full evaluate/enhance/judge/revise
 * pipeline instead of the bare engine loop. `opts.pipeline` (an explicit
 * `--pipeline` / a hypothetical future `--no-pipeline`) always wins when set;
 * otherwise `OXAGEN_BEST_OF_N_PIPELINE` sets the default, so a caller (e.g.
 * the bench adapter's differentiated config) can opt every `solve` invocation
 * into the full pipeline without passing the flag on every call. Neither set
 * ⇒ bare (unchanged default), the cheaper mode. Exported as a pure function
 * so this branch is unit-testable without standing up `handleSolve`'s full
 * session/AI-port machinery.
 */
export function resolveFullPipeline(
  opts: Pick<SolveOptions, "pipeline">,
): boolean {
  return opts.pipeline ?? process.env["OXAGEN_BEST_OF_N_PIPELINE"] === "1";
}

/**
 * Whether every candidate should auto-verify (union + re-run the test/lint/
 * build commands any candidate ran, across every surviving candidate's
 * worktree, before selection). Mirrors `resolveFullPipeline`'s precedence:
 * `opts.verifyAuto` (an explicit `--verify-auto`) always wins when set;
 * otherwise `OXAGEN_BEST_OF_N_VERIFY` sets the default, so the bench
 * adapter's differentiated config can turn it on without passing the flag on
 * every call. Neither set ⇒ off. Exported as a pure function so this branch
 * is unit-testable without standing up `handleSolve`'s full session/AI-port
 * machinery.
 */
export function resolveVerifyAuto(
  opts: Pick<SolveOptions, "verifyAuto">,
): boolean {
  return opts.verifyAuto ?? process.env["OXAGEN_BEST_OF_N_VERIFY"] === "1";
}

export async function handleSolve(
  prompt: string,
  opts: SolveOptions,
): Promise<void> {
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
  // Every model call the race makes — candidate turns, pipeline judges, the
  // comparative selector — flows through this one metered port; fold each
  // priced call into the run's cost/token totals so solve reports real usage
  // (the one-shot path's `--verbose` roll-up had no best-of-N equivalent).
  const usage = createSolveUsageAccumulator();
  const ai = createMeteredAi(baseAi, {
    onLog: (line) => void debugLog("timeout", line),
    onMetrics: (ev) => usage.record(ev),
  });

  const models = opts.models
    ? opts.models
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : opts.model
      ? [opts.model]
      : undefined;

  const candidates = Math.max(1, Math.min(opts.candidates ?? 3, 10));
  const fullPipeline = resolveFullPipeline(opts);
  const verifyAuto = resolveVerifyAuto(opts);

  void debugLog("turn", "solve.start", {
    prompt,
    candidates,
    verify: opts.verify,
    models,
    fullPipeline,
    verifyAuto,
  });

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
    fullPipeline,
    verifyAuto,
    usageTotals: usage.totals,
  });

  // Exit non-zero when nothing viable was produced, so scripts can branch on it.
  if (!result.selection.winnerId) process.exitCode = 1;
}
