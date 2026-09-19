/**
 * `oxagen approvals resolved`: the workspace's resolved approvals, most
 * recently resolved first, the read side of `list_resolved_approvals`
 * (#3153). Shows what a decision rule released without a person alongside
 * what a person approved or denied, so an operator can answer "which rule
 * released this call, and when" from the CLI.
 *
 * POSTs `/v1/{org}/{ws}/agent/approvals/resolved`. `--json` prints the raw
 * contract output for scripting; the default view is a table with the
 * approver column showing `policy:<rule id>` for an auto-approved row and
 * `user:<usr_…>` for one a person resolved.
 */
import { apiPostOrThrow, printTable } from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

// Local mirror of the list_resolved_approvals contract output. The CLI talks
// to the API over HTTP and does not depend on @oxagen/oxagen, so the response
// shape is declared here (kept in sync with
// packages/oxagen/src/contracts/agent.approval.list_resolved.ts).
interface ResolvedApprovalItem {
  id: string;
  runId: string | null;
  tool: string;
  requester: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string;
  resolution: "approved" | "denied" | "expired";
  resolvedBy: string | null;
  autoRuleId: string | null;
  autoEligibility: {
    ruleId: string;
    ok: boolean;
    reasons: string[];
    floor: boolean;
  } | null;
  mandateId: string | null;
  chain: { agentKey: string | null; rule: string | null };
}

interface ListResolvedApprovalsOutput {
  items: ResolvedApprovalItem[];
  nextCursor: string | null;
}

export interface ApprovalsResolvedOptions {
  run?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
  json?: boolean;
}

export async function approvalsResolved(
  opts: ApprovalsResolvedOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let result: ListResolvedApprovalsOutput;
  try {
    result = await apiPostOrThrow<ListResolvedApprovalsOutput>(
      "agent/approvals/resolved",
      {
        runId: opts.run,
        since: opts.since,
        until: opts.until,
        limit: opts.limit,
        cursor: opts.cursor,
      },
    );
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  if (cmd.isJson) {
    cmd.data(result);
    return;
  }
  if (result.items.length === 0) {
    writer.write("No resolved approvals in this range.");
    return;
  }
  printTable(
    ["ID", "TOOL", "RESOLUTION", "RESOLVED BY", "RESOLVED AT", "RUN"],
    result.items.map((item) => [
      item.id,
      item.tool,
      item.resolution,
      item.resolvedBy ?? "—",
      item.resolvedAt,
      item.runId ?? "—",
    ]),
    writer,
  );
  if (result.nextCursor) {
    writer.write("");
    writer.write(
      `More results: pass --cursor ${result.nextCursor} for the next page.`,
    );
  }
}
