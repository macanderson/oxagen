/**
 * `tachod` entry: run the collector in the foreground until SIGTERM. A
 * service unit written before the `oxagen` CLI took the recorder's commands
 * (#4879) runs exactly this, or `tacho daemon` from the compiled single
 * binary. New enrollments run `oxagen daemon`. All three run the same body.
 */
import { printAliasNotice } from "../cli/alias";
import { runDaemonProcess } from "./run";

export async function main(): Promise<void> {
  await runDaemonProcess();
}

/**
 * A promise this process never awaited, rejected. Several of the daemon's
 * own lanes are fire-and-forget by design — the git reconciliation lane
 * (`startGitReads`), the model proxy listener's retrying bind — because
 * awaiting them would hold up the control path they were split off to keep
 * clear. Node's default for an unhandled rejection is to crash the process,
 * which turns one of those lane's bugs into a host that stops recording and
 * shipping evidence entirely until systemd restarts it — the outage this
 * whole file exists to survive, self-inflicted. Logging and continuing is
 * the daemon's answer everywhere else a lane can fail (`controlTick`'s own
 * per-stage isolation, the git lane's own `.catch`); this is the same answer
 * for the one that reaches all the way out of every `try`.
 */
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `tachod: unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`,
  );
});

printAliasNotice("tachod");
main().catch((error) => {
  process.stderr.write(
    `tachod: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
