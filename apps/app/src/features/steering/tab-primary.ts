// Whether the Assignments, Gates, Proposals or Compiler body takes the gold
// from the hub header (roadmap pages/steering.md: "A tab that holds its own
// primary action takes the gold from the header", and every empty state's
// header "holds no gold").
//
// - Assignments with no enrolled agent: the empty state's Open Agents is not
//   gold, and the header holds none, so the screen has no gold at all.
// - The Compiler with no published record: "Nothing to compile yet" carries
//   Write a context record as the gold.
// - Proposals with no proposal in the state shown: the empty state carries
//   no gold, so the header holds none either. A Context PR's own actions sit
//   on its page (#5077), outside this hub.
//
// Each read here is the one the body makes next, with the same input, so the
// kernel's per-request read table answers the body without a second invoke
// (server/kernel.ts, readsThisRequest).
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import type { SteeringView } from "./view";

/**
 * `empty`: the body is an empty state, and the header draws no create button
 * at all. `primary`: the body holds the gold, and the header's button is drawn
 * secondary. Null: the header keeps the gold.
 */
export type BodyGold = "empty" | "primary" | null;

export async function bodyTakesHeaderGold({
  ctx,
  source,
  view,
  published,
}: {
  ctx: WsCtx;
  source: DataSource;
  view: SteeringView;
  /** Records in force, from the hub's own read. */
  published: number;
}): Promise<BodyGold> {
  switch (view.tab) {
    case "compiler":
      return published === 0 ? "empty" : null;
    case "assignments": {
      const agents = await source.agents.list(ctx, { cursor: null });
      return agents.ok && agents.value.totals.enrolled === 0 ? "empty" : null;
    }
    case "proposals": {
      if (view.offset !== 0) return null;
      // The same input the tab body reads with, size and state included, so
      // the kernel's per-request read table answers the body without a
      // second invoke (#4693).
      const page = await source.steering.proposals(ctx, {
        offset: 0,
        limit: view.rows,
        state: view.state ?? "open",
      });
      return page.ok && page.value.total === 0 ? "empty" : null;
    }
    case "gates":
    case "library":
      return null;
  }
}
