// graph.ts: the stage graph a workflow's `needs` draws.
//
// A stage with `needs` runs when every stage it names has handed off. A stage
// without `needs` runs after the stage before it in the file, so every v0.1
// file reads the same under v0.2 and v0.3 (work-graph-spec.md §8.1). These
// helpers take the needs after that rule applies.

/** One stage as the graph sees it. */
export interface StageNode {
  role: string;
  needs: readonly string[];
}

/** Every role a stage waits on, directly or through other stages. */
export function upstreamOf(stages: readonly StageNode[], role: string): Set<string> {
  const byRole = new Map(stages.map((stage) => [stage.role, stage.needs]));
  const seen = new Set<string>();
  const queue = [...(byRole.get(role) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(byRole.get(next) ?? []));
  }
  return seen;
}

/** Every role that waits on a stage, directly or through other stages. */
export function downstreamOf(stages: readonly StageNode[], role: string): Set<string> {
  const seen = new Set<string>();
  const queue = [role];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const stage of stages) {
      if (stage.needs.includes(current) && !seen.has(stage.role)) {
        seen.add(stage.role);
        queue.push(stage.role);
      }
    }
  }
  return seen;
}

/** The roles no other stage needs, in file order. [accept] needs each of them. */
export function sinksOf(stages: readonly StageNode[]): string[] {
  const needed = new Set(stages.flatMap((stage) => stage.needs));
  return stages.filter((stage) => !needed.has(stage.role)).map((stage) => stage.role);
}

/**
 * The roles on one cycle through `needs`, in order, or null when there is none.
 * Needs that name no stage are ignored here. The parser reports them.
 */
export function findCycle(stages: readonly StageNode[]): string[] | null {
  const byRole = new Map(stages.map((stage) => [stage.role, stage.needs]));
  const done = new Set<string>();
  const path: string[] = [];
  const onPath = new Set<string>();

  const visit = (role: string): string[] | null => {
    if (onPath.has(role)) return path.slice(path.indexOf(role));
    const needs = byRole.get(role);
    if (done.has(role) || needs === undefined) return null;
    path.push(role);
    onPath.add(role);
    for (const need of needs) {
      const cycle = visit(need);
      if (cycle) return cycle;
    }
    path.pop();
    onPath.delete(role);
    done.add(role);
    return null;
  };

  for (const stage of stages) {
    const cycle = visit(stage.role);
    if (cycle) return cycle;
  }
  return null;
}
