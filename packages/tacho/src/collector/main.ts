/**
 * `tachod` entry: run the collector in the foreground until SIGTERM. The
 * service unit written by `tacho enroll` runs exactly this.
 */
import { writeFileSync } from "node:fs";
import { tachoPaths } from "../host/paths";
import { startDaemon } from "./daemon";

export async function main(): Promise<void> {
  const paths = tachoPaths(process.env);
  const daemon = await startDaemon({ paths });
  writeFileSync(paths.pid, `${process.pid}\n`);
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`tachod: ${signal}, stopping\n`);
    daemon
      .stop()
      .then(() => process.exit(0))
      .catch((error) => {
        process.stderr.write(
          `tachod: stop failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGHUP", () => {
    daemon.refreshBundle().catch(() => undefined);
  });
}

main().catch((error) => {
  process.stderr.write(
    `tachod: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
