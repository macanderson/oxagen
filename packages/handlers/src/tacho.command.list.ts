// `list_commands`: the delivery report for one run (Mission Control spec
// §7.4, §7.6). Every row addressed to the run, newest first, in the recorded
// status with one derivation: a row that is not terminal and whose expiry
// has passed reads `expired`, which is what the host's next poll would write
// and what a host that stopped polling never will.
//
// The run is fenced the way `get_run` fences it: a `tse_…` id resolves only
// in the caller's workspace, an `arun_…` id through the ledger's RLS and the
// identity query; an id neither resolves is `not_found`.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  type CommandReportItem,
  type ListCommandsOutput,
  tachoCommandList,
} from "@oxagen/oxagen/contracts/tacho.command.list";
import { schema, withTenantDb } from "@oxagen/database";
import { createPostgresRunStore, type RunStore } from "@oxagen/run-ledger";
import { and, desc, eq } from "drizzle-orm";
import {
  postgresRunQueries,
  type RunQueries,
  type RunScope,
  runScope,
} from "./run.list";

export type CommandRow = Pick<
  typeof schema.tachoControlCommands.$inferSelect,
  | "publicId"
  | "command"
  | "outcome"
  | "requestedMode"
  | "deliveryMode"
  | "degradedReason"
  | "reason"
  | "issuedAt"
  | "expiresAt"
  | "deliveredAt"
  | "acknowledgedAt"
  | "appliedAt"
  | "appliedAtSeq"
  | "outcomeDetail"
>;

const TERMINAL: ReadonlySet<string> = new Set(
  schema.TACHO_COMMAND_TERMINAL_OUTCOMES,
);

/** The status a report shows: the recorded one, or `expired` once the clock passed it. */
export function reportedStatus(
  row: Pick<CommandRow, "outcome" | "expiresAt">,
  now: Date,
): CommandReportItem["status"] {
  if (
    !TERMINAL.has(row.outcome) &&
    row.expiresAt !== null &&
    row.expiresAt.getTime() <= now.getTime()
  ) {
    return "expired";
  }
  return row.outcome as CommandReportItem["status"];
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toReportItem(row: CommandRow, now: Date): CommandReportItem {
  return {
    id: row.publicId,
    command: row.command as CommandReportItem["command"],
    status: reportedStatus(row, now),
    requestedMode: row.requestedMode as CommandReportItem["requestedMode"],
    deliveryMode: row.deliveryMode as CommandReportItem["deliveryMode"],
    degradedReason: row.degradedReason,
    reason: row.reason,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: iso(row.expiresAt),
    sentAt: iso(row.deliveredAt),
    acknowledgedAt: iso(row.acknowledgedAt),
    appliedAt: iso(row.appliedAt),
    appliedAtSeq: row.appliedAtSeq,
    detail: row.outcomeDetail,
  };
}

export type ListCommandsDeps = {
  queries: Pick<RunQueries, "ledgerIdentity" | "tachoSession">;
  store: Pick<RunStore, "getRunByPublicId">;
  /** Rows addressed to the run, newest first. */
  commandsForRun: (
    scope: RunScope,
    runPublicId: string,
    limit: number,
  ) => Promise<CommandRow[]>;
  now: () => Date;
};

const runNotFound = () =>
  new HandlerError({ code: "not_found", reason: "run_not_found" });

export function createListCommandsHandler(
  deps: ListCommandsDeps,
): CapabilityHandler<typeof tachoCommandList> {
  return async (input, ctx): Promise<ListCommandsOutput> => {
    const scope = runScope(ctx);
    if (input.runId.startsWith("tse_")) {
      if (!(await deps.queries.tachoSession(scope, input.runId)))
        throw runNotFound();
    } else {
      const summary = await deps.store.getRunByPublicId(input.runId);
      if (!summary) throw runNotFound();
      if (!(await deps.queries.ledgerIdentity(scope, summary.runId)))
        throw runNotFound();
    }
    const now = deps.now();
    const rows = await deps.commandsForRun(scope, input.runId, input.limit);
    return { commands: rows.map((row) => toReportItem(row, now)) };
  };
}

const commands = schema.tachoControlCommands;

export function defaultListCommandsDeps(): ListCommandsDeps {
  // Construction is pure: nothing connects until a read runs inside the scope.
  const ledger = createPostgresRunStore();
  return {
    queries: postgresRunQueries,
    store: { getRunByPublicId: (id) => ledger.getRunByPublicId(id) },
    commandsForRun: (scope, runPublicId, limit) =>
      withTenantDb((tx) =>
        tx
          .select({
            publicId: commands.publicId,
            command: commands.command,
            outcome: commands.outcome,
            requestedMode: commands.requestedMode,
            deliveryMode: commands.deliveryMode,
            degradedReason: commands.degradedReason,
            reason: commands.reason,
            issuedAt: commands.issuedAt,
            expiresAt: commands.expiresAt,
            deliveredAt: commands.deliveredAt,
            acknowledgedAt: commands.acknowledgedAt,
            appliedAt: commands.appliedAt,
            appliedAtSeq: commands.appliedAtSeq,
            outcomeDetail: commands.outcomeDetail,
          })
          .from(commands)
          .where(
            and(
              eq(commands.orgId, scope.orgId),
              eq(commands.workspaceId, scope.workspaceId),
              eq(commands.targetKind, "run"),
              eq(commands.targetId, runPublicId),
            ),
          )
          .orderBy(desc(commands.issuedAt), desc(commands.publicId))
          .limit(limit),
      ),
    now: () => new Date(),
  };
}

export const tachoCommandListHandler = createListCommandsHandler(
  defaultListCommandsDeps(),
);
