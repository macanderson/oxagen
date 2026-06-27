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
import { openPlanStore } from "../../agent/fleet/store.js";
import { loadProjectContext } from "../../agent/project-context.js";
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
}

export async function launchFleetView(opts: FleetViewOptions): Promise<void> {
  const { cwd } = opts;
  // `loadProjectContext` is synchronous (it just reads CLAUDE.md/AGENTS.md).
  const projectContext = loadProjectContext(cwd);
  const memory = openFleetMemory(cwd);
  const store = openPlanStore(cwd);

  const fleet = new Fleet({
    cwd,
    concurrency: opts.concurrency,
    memory,
    store,
    projectContext,
    readOnly: opts.readOnly,
  });

  // Stable, closed-over planner so the goal is decomposed — and persisted to the
  // plan store before the fleet's own task-level writes — exactly once.
  const goal = opts.goal;
  const plan = goal
    ? async (signal: AbortSignal): Promise<Plan> => {
        const planned = await planTasks({ goal, cwd, memory, signal });
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
}
