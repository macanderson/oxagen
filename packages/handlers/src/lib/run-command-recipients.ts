// The per-recipient write of a run command (Mission Control spec §7.6), shared
// by `dispatch_command` and `pause_workspace_runs`.
//
// One `tacho.control_commands` row is written for each recipient run. A run
// that can take the command gets a `queued` row, and that row supersedes any
// earlier `queued` row of the same command on the run, so the run never holds
// two pauses or two steers where the operator meant one. A run that cannot
// take it gets a `failed` row with the reason in `outcome_detail`, so the
// delivery report (`list_commands`) names every run the decision addressed.
// A failed row supersedes nothing.
//
// The caller decides the reason (`commandBlockOf`, and `steerBlockOf` for a
// steer) and builds the payload and the delivery mode. This function owns the
// one rule both callers must agree on: what gets written for each outcome.
import type {
  CommandBlock,
  SteerBlock,
} from "@oxagen/oxagen/contracts/run.list";
import type { CommandRowInput, CommandStore } from "../tacho.command.dispatch";

/** A command row before the recipient's reason decides its outcome. */
export type RecipientCommandRow = Omit<
  CommandRowInput,
  "outcome" | "outcomeDetail"
>;

/** What one recipient's write left on the table. */
export type RecipientWrite = {
  /** The `tcm_…` id of the row written for the run. */
  publicId: string;
  /** True for a `queued` row; false for a `failed` one. */
  queued: boolean;
};

/**
 * Write one recipient's command row. `block` is null when the run can take
 * the command, else the reason it cannot, recorded as the row's
 * `outcome_detail`.
 */
export async function writeRecipientCommand(
  store: CommandStore,
  row: RecipientCommandRow,
  block: CommandBlock | SteerBlock | null,
): Promise<RecipientWrite> {
  const queued = block === null;
  const { publicId } = await store.insert({
    ...row,
    outcome: queued ? "queued" : "failed",
    outcomeDetail: block,
  });
  if (queued) {
    await store.supersede({
      scope: row.scope,
      runPublicId: row.session.publicId,
      command: row.command,
      successorPublicId: publicId,
      now: row.issuedAt,
    });
  }
  return { publicId, queued };
}
