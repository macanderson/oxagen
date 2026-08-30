/**
 * Agents screen entry point.
 *
 * Wires the standalone pieces together: loads the project rules, opens the durable
 * fleet memory + plan store, constructs the {@link Fleet}, and renders the live
 * {@link FleetApp}. When a goal is supplied it plans it into tasks first (showing a
 * planning state); otherwise it boots an empty roster the user dispatches into.
 *
 * TTY → the live {@link FleetApp}. Non-TTY / `--json` → the same task/conflict
 * events as JSONL on stdout via {@link runFleetHeadless}, ending with a
 * machine-readable summary (mirrors the split in `tui/best-of-n-view/index.tsx`).
 *
 * Launch with: `oxagen agents [goal...]`.
 */
import { render } from "ink";
import React from "react";
import { Fleet } from "../../agent/fleet/orchestrator.js";
import { planTasks } from "../../agent/planner.js";
import { openFleetMemory } from "../../agent/fleet/memory.js";
import { runFleetHeadless } from "../../agent/fleet/headless.js";
import { createServerMemory } from "../../agent/adapters/index.js";
import { resolveApiContext } from "../../lib/api.js";
import { openPlanStore } from "../../agent/fleet/store.js";
import { WorktreeManager, isGitRepo } from "../../agent/fleet/git-isolation.js";
import { loadProjectContext } from "../../agent/project-context.js";
import { loadAgents } from "../../agents/loader.js";
import { FleetApp } from "./fleet-app.js";
import type { FleetSnapshot, Plan } from "../../agent/fleet/types.js";

export interface FleetViewOptions {
  cwd: string;
  /** A high-level goal to decompose into tasks and run immediately. */
  goal?: string;
  /** Max subagents in flight at once (defaults to the Fleet's own cap). */
  concurrency?: number;
  /** Read-only subagents: explain, don't edit. */
  readOnly?: boolean;
  /**
   * Run each agent in its own git worktree (commits pinned, work merged back),
   * so parallel agents can't clobber the tree. Defaults to true; pass `false`
   * (the CLI's `--no-isolate`) to share `cwd` directly instead. Falls back to
   * `false` automatically when `cwd` isn't a git repo.
   */
  isolate?: boolean;
  /** Headless: stream JSONL task events instead of the live view. Forced on automatically when stdout isn't a TTY (e.g. CI). */
  headless?: boolean;
}

export async function launchFleetView(
  opts: FleetViewOptions,
): Promise<FleetSnapshot> {
  const { cwd } = opts;
  // `loadProjectContext` is synchronous (it just reads CLAUDE.md/AGENTS.md).
  const projectContext = loadProjectContext(cwd);
  const memory = openFleetMemory(cwd);
  // Platform memory shared across all subagents: recall prior-session lessons
  // before each task, mirror finished-task lessons back. Only when the CLI is
  // authenticated; null degrades the fleet to local-only. The kill switch
  // (OXAGEN_DISABLE_MEMORY=1) is enforced inside the handle itself.
  const serverMemory = resolveApiContext()
    ? createServerMemory({
        agentId: "fleet",
        executionRef: `cli:fleet-${Date.now()}`,
        projectName: cwd.split("/").pop() || undefined,
      })
    : null;
  const store = openPlanStore(cwd);
  // Named agents the planner may assign tasks to, and the fleet dispatches by.
  const agents = loadAgents({ cwd });

  // Per-agent git isolation defaults ON: each task gets its own worktree and
  // its work is merged back explicitly, so parallel agents physically can't
  // clobber the tree or each other. Each run gets its own ref/branch namespace
  // so concurrent runs never collide. Read-only fleets never write, so
  // isolation is moot there; a non-git cwd falls back to the shared tree
  // instead of failing every task at spawn().
  const isolation =
    opts.isolate !== false && !opts.readOnly && (await isGitRepo(cwd))
      ? new WorktreeManager({
          repoRoot: cwd,
          namespace: `session-${Date.now()}`,
        })
      : null;

  const fleet = new Fleet({
    cwd,
    concurrency: opts.concurrency,
    memory,
    serverMemory,
    store,
    projectContext,
    agents,
    readOnly: opts.readOnly,
    isolation,
  });

  // Stable, closed-over planner so the goal is decomposed — and persisted to the
  // plan store before the fleet's own task-level writes — exactly once.
  const goal = opts.goal;
  const plan = goal
    ? async (signal: AbortSignal): Promise<Plan> => {
        const planned = await planTasks({
          goal,
          cwd,
          memory,
          agents: [...agents.values()],
          signal,
        });
        store.save(planned);
        return planned;
      }
    : undefined;

  const headless = opts.headless || !process.stdout.isTTY;
  if (headless) {
    // Headless has no interactive dispatch line — a goal is the only way to
    // give it work.
    if (!plan) {
      process.stderr.write(
        'oxagen agents --json requires a goal, e.g. `oxagen agents --json "add rate limiting"`.\n',
      );
      process.exitCode = 1;
      if (isolation) await isolation.cleanupAll();
      return fleet.snapshot();
    }
    try {
      return await runFleetHeadless({ fleet, plan });
    } finally {
      if (isolation) await isolation.cleanupAll();
    }
  }

  const { waitUntilExit } = render(
    <FleetApp fleet={fleet} goal={goal} plan={plan} />,
    // Ctrl-C is handled inside FleetApp (cancel-drain, then exit), not by Ink.
    { exitOnCtrlC: false },
  );
  await waitUntilExit();

  // Tear down worktrees on exit. The refs/oxagen/agents pins are kept, so every
  // committed change remains recoverable by hash even after cleanup. By now
  // every task has already reached a terminal state (FleetApp only exits after
  // fleet.start()/drain() settles), so every per-task worktree is already
  // disposed and this is just the final integration-worktree sweep.
  if (isolation) await isolation.cleanupAll();
  return fleet.snapshot();
}
