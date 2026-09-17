// list_recent_runs: the command menu's Runs group, read through the list_runs
// handler so the in-app agent's turns stay excluded and both stores are
// merged newest first, then narrowed to the four fields a menu row shows.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { runRecentList } from "@oxagen/oxagen/contracts/run.recent.list";
import { runListHandler } from "./run.list";

export const runRecentListHandler: CapabilityHandler<
  typeof runRecentList
> = async (input, ctx) => {
  const page = await runListHandler({ limit: input.limit }, ctx);
  return {
    runs: page.runs.map((run) => ({
      id: run.id,
      agentKey: run.agentKey,
      status: run.status,
      startedAt: run.startedAt,
    })),
  };
};
