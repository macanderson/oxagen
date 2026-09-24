// Whether the Assignments, Gates, Proposals or Compiler body takes the gold
// from the hub header (roadmap pages/steering.md: "A tab that holds its own
// primary action takes the gold from the header", and every empty state's
// header "holds no gold").
//
// - Assignments with no enrolled agent: the empty state's Open Agents is not
//   gold, and the header holds none, so the screen has no gold at all.
// - The Compiler with no published record: "Nothing to compile yet" carries
//   Write a context record as the gold.
// - Proposals with no proposal: "No proposals yet" carries it.
// - A proposal under review, or a selected Context PR, with no pull request
//   yet: Open a Context PR is the gold. With every check passed: Merge pull
//   request is.
//
// Each read here is the one the body makes next, with the same input, so the
// kernel's per-request read table answers the body without a second invoke
// (server/kernel.ts, readsThisRequest).
import type { ContextPr } from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
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
  pr,
}: {
  ctx: WsCtx;
  source: DataSource;
  view: SteeringView;
  /** Records in force, from the hub's own read. */
  published: number;
  /** get_context_pr for the proposal the URL names, when it names one. */
  pr: Read<ContextPr> | null;
}): Promise<BodyGold> {
  switch (view.tab) {
    case "compiler":
      return published === 0 ? "empty" : null;
    case "assignments": {
      const agents = await source.agents.list(ctx, { cursor: null });
      return agents.ok && agents.value.totals.enrolled === 0 ? "empty" : null;
    }
    case "proposals": {
      if (view.proposal !== null) {
        if (pr === null || !pr.ok) return null;
        // The review's Context PR box links to an open pull request rather
        // than merging it; only the Context PRs view carries Merge.
        return pr.value.status === "proposed" ||
          (view.segment === "prs" && pr.value.status === "checks_passed")
          ? "primary"
          : null;
      }
      if (view.offset !== 0) return null;
      const page = await source.steering.proposals(ctx, { offset: 0 });
      return page.ok && page.value.total === 0 ? "empty" : null;
    }
    case "gates":
    case "library":
      return null;
  }
}
