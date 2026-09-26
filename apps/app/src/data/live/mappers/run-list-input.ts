// The Fleet runs query to `list_runs` input (#3837). Only what the query
// sets is sent, so a query with no filter, search, order or offset asks for
// exactly what it asked for before those inputs existed, and the kernel
// seam's read memo keys two equal queries to one read.
import type { runList } from "@oxagen/oxagen/contracts/run.list";
import type { DataSource } from "@/data/ports";

type RunListQuery = Parameters<DataSource["runs"]["list"]>[1];
type RunListInput = (typeof runList)["input"]["_input"];

/**
 * Runs per read when the caller names no page size: the contract's ceiling.
 * Fleet names one (its page-size choice); the agents page and the choice
 * dialogs read the ceiling.
 */
const RUN_PAGE = 100;

export function toRunListInput(q: RunListQuery): RunListInput {
  const query = q.query?.trim() ?? "";
  return {
    limit: q.limit ?? RUN_PAGE,
    ...(q.cursor === null ? {} : { cursor: q.cursor }),
    ...(q.pullRequests === undefined || q.pullRequests === "any"
      ? {}
      : { pullRequests: q.pullRequests }),
    ...(q.status === undefined || q.status.length === 0
      ? {}
      : { status: q.status }),
    ...(q.tier === undefined || q.tier.length === 0 ? {} : { tier: q.tier }),
    ...(q.replayGrade === undefined || q.replayGrade.length === 0
      ? {}
      : { replayGrade: q.replayGrade }),
    ...(query === "" ? {} : { query }),
    // Newest first is the read's own order, so it is left out.
    ...(q.sort === undefined ||
    (q.sort.key === "started" && q.sort.dir === "desc")
      ? {}
      : { sort: q.sort }),
    ...(q.offset === undefined || q.offset === 0 ? {} : { offset: q.offset }),
    ...(q.count === true ? { count: true } : {}),
    ...(q.countLive === true ? { countLive: true } : {}),
  };
}
