/**
 * `tachod` entry: run the collector in the foreground until SIGTERM. The
 * service unit written by `tacho enroll` runs exactly this (or, from the
 * compiled single binary, `tacho daemon`, which is the same body).
 */
import { runDaemonProcess } from "./run";

export async function main(): Promise<void> {
  await runDaemonProcess();
}

main().catch((error) => {
  process.stderr.write(
    `tachod: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
