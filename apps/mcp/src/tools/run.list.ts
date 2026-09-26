import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runList } from "@oxagen/oxagen/contracts/run.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...runList.input.shape,
  limit: runList.input.shape.limit.describe("Max runs to return (1–100)"),
  cursor: runList.input.shape.cursor.describe(
    "The nextCursor of an earlier page; omit for the first page. Not with offset, or with any sort but started descending",
  ),
  pullRequests: runList.input.shape.pullRequests.describe(
    "any (default), with or without: wrapped sessions whose record names a pull request, or names none. Pages newest first by cursor only",
  ),
  status: runList.input.shape.status.describe(
    "Only runs in these statuses: live, sealed, halted",
  ),
  tier: runList.input.shape.tier.describe(
    "Only runs published at these tiers: contained, gateway, harness, observe. A ledger run with no graded seal is harness",
  ),
  replayGrade: runList.input.shape.replayGrade.describe(
    "Only runs with these replay grades: inspect, view, fork, retry, or not_recorded for none",
  ),
  query: runList.input.shape.query.describe(
    "Case-insensitive text matched against the run id, name, harness title, agent key, operator name, model id, hostname and ledger goal",
  ),
  sort: runList.input.shape.sort.describe(
    "The order: key started, agent, operator, status, tier, replay or cost, dir asc or desc. Default started desc. Missing values sort last",
  ),
  offset: runList.input.shape.offset.describe(
    "Rows to skip in the filtered, sorted list (0 to 10000). Page N of size L is (N - 1) * L. Not with cursor",
  ),
};

export const metadata: ToolMetadata = {
  name: runList.name,
  description: runList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function runListTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(runList.name, args, ctx, { surface: "mcp" });
  return runList.output.parse(output);
}
