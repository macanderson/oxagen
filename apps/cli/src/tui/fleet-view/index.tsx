/**
 * Agents screen entry point.
 *
 * Wires the standalone pieces together: loads the project rules, opens the durable
 * fleet memory + plan store, constructs the {@link Fleet}, and renders the live
 * {@link FleetApp}. When a goal is supplied it plans it into tasks first (showing a
 * planning state); otherwise it boots an empty roster the user dispatches into.
 *
 * Launch with: `oxagen agents [goal...]`.
 */
import { render } from "ink";
import React from "react";
import { Fleet } from "../../agent/fleet/orchestrator.js";
import { planTasks } from "../../agent/planner.js";
import { openFleetMemory } from "../../agent/fleet/memory.js";
import { createServerMemory } from "../../agent/adapters/index.js";
import { resolveApiContext } from "../../lib/api.js";
import { openPlanStore } from "../../agent/fleet/store.js";
import { WorktreeManager } from "../../agent/fleet/git-isolation.js";
import { loadProjectContext } from "../../agent/project-context.js";
import { loadAgents } from "../../agents/loader.js";
import { FleetApp } from "./fleet-app.js";
import type { Plan } from "../../agent/fleet/types.js";

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
   * so parallel agents can't clobber the tree. Requires `cwd` to be a git repo.
   */
  isolate?: boolean;
}

export async function launchFleetView(opts: FleetViewOptions): Promise<void> {
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

  // Per-agent git isolation is opt-in. Each run gets its own ref/branch
  // namespace so concurrent runs never collide. Read-only fleets never write,
  // so isolation is moot there.
  const isolation =
    opts.isolate && !opts.readOnly
      ? new WorktreeManager({ repoRoot: cwd, namespace: `session-${Date.now()}` })
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
        const planned = await planTasks({ goal, cwd, memory, agents: [...agents.values()], signal });
        store.save(planned);
        return planned;
      }
    : undefined;

  const { waitUntilExit } = render(
    <FleetApp fleet={fleet} goal={goal} plan={plan} />,
    // Ctrl-C is handled inside FleetApp (cancel all, then exit), not by Ink.
    { exitOnCtrlC: false },
  );
  await waitUntilExit();

  // Tear down worktrees on exit. The refs/oxagen/agents pins are kept, so every
  // committed change remains recoverable by hash even after cleanup.
  if (isolation) await isolation.cleanupAll();
}
