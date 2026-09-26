// `list_commands`: the delivery report for one run, or for the commands one
// broadcast queued (Mission Control spec §7.4, §7.6). Every row addressed to
// the run, or every row the ids name, newest first, in the recorded status
// with one derivation: a `queued` row whose expiry has passed reads
// `expired`, the status the sweep writes on the host's next poll
// (`expireCommands` in ./lib/tacho-host.ts, the same predicate). A row the
// host holds (`sent`, `received`, `acknowledged`) reads as recorded whatever
// the clock says: the host settles it with `applied`, `expired` or `failed`,
// and until then the report carries `expiresAt` for the app to render
// "past expiry, awaiting the host". Nothing shown is a status nobody wrote.
//
// Each row names its run (`target_id`), the person who issued it
// (`issued_by_user_id` joined to `auth.users`, a blank name read as none),
// and, for a steer or a message, the text it carried (`payload.text`).
//
// The run is fenced the way `get_run` fences it: a `tse_…` id resolves only
// in the caller's workspace, an `arun_…` id through the ledger's RLS and the
// identity query; an id neither resolves is `not_found`. A read by
// `commandIds` is fenced by the same workspace predicate the run read uses,
// so an id from another workspace, or one that names no command, is left out
// rather than refused. A run read returns rows addressed to the run. A read by
// ids also returns a steer held for an idle agent's next run (`target_kind`
// `agent`), which a broadcast's ids name: the row carries the agent key in
// place of a run until ingest re-addresses it at that run's genesis. Neither
// read returns a host-addressed row, which names no run and no agent.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  type CommandReportItem,
  type ListCommandsOutput,
  tachoCommandList,
} from "@oxagen/oxagen/contracts/tacho.command.list";
import { schema, withTenantDb } from "@oxagen/database";
import { createPostgresRunStore, type RunStore } from "@oxagen/run-ledger";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import {
  postgresRunQueries,
  type RunQueries,
  type RunScope,
  runScope,
} from "./run.list";

export type CommandRow = Pick<
  typeof schema.tachoControlCommands.$inferSelect,
  | "publicId"
  | "targetKind"
  | "targetId"
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
> & {
  /** `payload.text`; null when the payload carries none. */
  payloadText: string | null;
  /** The issuer's `users.public_id` (`usr_…`); null when the row names no user. */
  issuedByPublicId: string | null;
  /** The issuer's `users.display_name`, as stored. */
  issuedByName: string | null;
};

/** The commands that carry prompt content, and so the only ones whose text a report shows. */
const TEXT_COMMANDS: ReadonlySet<string> = new Set(["steer", "message"]);

const blankToNull = (value: string | null): string | null =>
  value === null || value.trim() === "" ? null : value;

/** The status a report shows: the recorded one, or `expired` for a `queued` row the clock passed. */
export function reportedStatus(
  row: Pick<CommandRow, "outcome" | "expiresAt">,
  now: Date,
): CommandReportItem["status"] {
  if (
    row.outcome === "queued" &&
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
    // A held steer names its agent until its run exists.
    runId: row.targetKind === "agent" ? null : row.targetId,
    agentKey: row.targetKind === "agent" ? row.targetId : null,
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
    issuedBy:
      row.issuedByPublicId === null
        ? null
        : { id: row.issuedByPublicId, name: blankToNull(row.issuedByName) },
    text: TEXT_COMMANDS.has(row.command) ? row.payloadText : null,
  };
}

type ListCommandsDeps = {
  queries: Pick<RunQueries, "ledgerIdentity" | "tachoSession">;
  store: Pick<RunStore, "getRunByPublicId">;
  /** Rows addressed to the run, newest first. */
  commandsForRun: (
    scope: RunScope,
    runPublicId: string,
    limit: number,
  ) => Promise<CommandRow[]>;
  /**
   * The rows among `commandIds` in the scope's workspace that are addressed
   * to a run, or held for an agent's next run, newest first.
   */
  commandsByIds: (
    scope: RunScope,
    commandIds: readonly string[],
    limit: number,
  ) => Promise<CommandRow[]>;
  now: () => Date;
};

const runNotFound = () =>
  new HandlerError({ code: "not_found", reason: "run_not_found" });

/** A read that names both a run and command ids, or neither. */
const runOrCommands = () =>
  new CapabilityError(
    tachoCommandList.name,
    "invalid_input",
    "run_or_commands",
  );

export function createListCommandsHandler(
  deps: ListCommandsDeps,
): CapabilityHandler<typeof tachoCommandList> {
  return async (input, ctx): Promise<ListCommandsOutput> => {
    const { runId, commandIds } = input;
    if ((runId === undefined) === (commandIds === undefined))
      throw runOrCommands();
    const scope = runScope(ctx);
    if (commandIds !== undefined) {
      const now = deps.now();
      const rows = await deps.commandsByIds(
        scope,
        [...new Set(commandIds)],
        input.limit,
      );
      return { commands: rows.map((row) => toReportItem(row, now)) };
    }
    if (runId === undefined) throw runOrCommands();
    if (runId.startsWith("tse_")) {
      if (!(await deps.queries.tachoSession(scope, runId))) throw runNotFound();
    } else {
      const summary = await deps.store.getRunByPublicId(runId);
      if (!summary) throw runNotFound();
      if (!(await deps.queries.ledgerIdentity(scope, summary.runId)))
        throw runNotFound();
    }
    const now = deps.now();
    const rows = await deps.commandsForRun(scope, runId, input.limit);
    return { commands: rows.map((row) => toReportItem(row, now)) };
  };
}

const commands = schema.tachoControlCommands;
const users = schema.users;

type TargetKind = (typeof schema.TACHO_COMMAND_TARGET_KINDS)[number];

/** The report's columns, the issuer's public id and name among them. */
const reportColumns = {
  publicId: commands.publicId,
  targetKind: commands.targetKind,
  targetId: commands.targetId,
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
  payloadText: sql<string | null>`${commands.payload}->>'text'`,
  issuedByPublicId: users.publicId,
  issuedByName: users.displayName,
};

/**
 * The target kinds each read returns. A run's report holds the rows addressed
 * to it. A broadcast's ids also name the steers it held for idle agents.
 */
const REPORT_TARGET_KINDS = {
  run: ["run"],
  ids: ["run", "agent"],
} as const satisfies Record<string, readonly TargetKind[]>;

/** The report's rows matching `where` in the scope's workspace, newest first. */
function readReport(
  scope: RunScope,
  kinds: readonly TargetKind[],
  where: SQL | undefined,
  limit: number,
): Promise<CommandRow[]> {
  return withTenantDb((tx) =>
    tx
      .select(reportColumns)
      .from(commands)
      .leftJoin(users, eq(users.id, commands.issuedByUserId))
      .where(
        and(
          eq(commands.orgId, scope.orgId),
          eq(commands.workspaceId, scope.workspaceId),
          inArray(commands.targetKind, [...kinds]),
          where,
        ),
      )
      .orderBy(desc(commands.issuedAt), desc(commands.publicId))
      .limit(limit),
  );
}

function defaultListCommandsDeps(): ListCommandsDeps {
  // Construction is pure: nothing connects until a read runs inside the scope.
  const ledger = createPostgresRunStore();
  return {
    queries: postgresRunQueries,
    store: { getRunByPublicId: (id) => ledger.getRunByPublicId(id) },
    commandsForRun: (scope, runPublicId, limit) =>
      readReport(
        scope,
        REPORT_TARGET_KINDS.run,
        eq(commands.targetId, runPublicId),
        limit,
      ),
    commandsByIds: (scope, commandIds, limit) =>
      readReport(
        scope,
        REPORT_TARGET_KINDS.ids,
        inArray(commands.publicId, [...commandIds]),
        limit,
      ),
    now: () => new Date(),
  };
}

export const tachoCommandListHandler = createListCommandsHandler(
  defaultListCommandsDeps(),
);
