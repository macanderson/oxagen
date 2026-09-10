/**
 * `tacho` entry: enroll, status, unenroll, export, verify, daemon.
 * `oxagen tacho <command>` in the platform CLI delegates here with its own
 * credentials.
 */
import { Command } from "commander";
import { startDaemon } from "../collector/daemon";
import { defaultCliDeps } from "./deps";
import { enroll } from "./enroll";
import { exportCommand } from "./export";
import { status } from "./status";
import { unenroll } from "./unenroll";
import { verify } from "./verify";

export function buildTachoProgram(): Command {
  const program = new Command();
  const deps = defaultCliDeps();
  program
    .name("tacho")
    .description(
      "Tacho: put this machine's Claude Code sessions under Oxagen control",
    )
    .version(deps.wrapperVersion);

  program
    .command("enroll")
    .description(
      "Enroll this machine: device key, host API key, tachod service, Claude Code hooks",
    )
    .option("--token <apiKey>", "Oxagen API token (or run `oxagen login`)")
    .option("--org <slug>", "Organization slug")
    .option("--workspace <slug>", "Workspace slug")
    .option("--api-url <url>", "Oxagen API base URL")
    .option("--port <n>", "Loopback port for tachod", (v) => Number(v))
    .option("--no-service", "Do not install the user service")
    .option("--managed", "Also print the managed settings document for MDM")
    .option(
      "--print-managed",
      "Only print the managed settings document; do not write user settings",
    )
    .option("--validity-days <n>", "Enrollment validity", (v) => Number(v))
    .option("--force", "Enroll again even if already enrolled")
    .option("--verify", "Run a headless Claude Code turn afterwards")
    .action(async (opts: Record<string, unknown>) => {
      const result = await enroll(
        {
          token: opts["token"] as string | undefined,
          org: opts["org"] as string | undefined,
          workspace: opts["workspace"] as string | undefined,
          apiUrl: opts["apiUrl"] as string | undefined,
          port: opts["port"] as number | undefined,
          service: opts["service"] as boolean | undefined,
          managed: opts["managed"] as boolean | undefined,
          printManaged: opts["printManaged"] as boolean | undefined,
          validityDays: opts["validityDays"] as number | undefined,
          force: opts["force"] as boolean | undefined,
        },
        deps,
      );
      if (!result.ok) {
        process.exitCode = 1;
        return;
      }
      if (opts["verify"] === true) {
        const verified = await verify({}, deps);
        deps.out(
          verified.ok
            ? `Verified: ${verified.detail}`
            : `Verify failed: ${verified.detail}`,
        );
        if (!verified.ok) process.exitCode = 1;
      }
    });

  program
    .command("status")
    .description("Enrollment, daemon, hooks, bundle, and spool status")
    .option("--json", "Machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const report = await status(
        { ...(opts.json !== undefined ? { json: opts.json } : {}) },
        deps,
      );
      if (!report.enrolled) process.exitCode = 1;
    });

  program
    .command("unenroll")
    .description(
      "Remove the hooks and the service, revoke the enrollment, delete the host key",
    )
    .option("--token <apiKey>", "Operator token for the server-side revoke")
    .option("--org <slug>")
    .option("--workspace <slug>")
    .option("--purge", "Also delete the local WAL, spool, and quarantine")
    .option("--reason <text>", "Reason recorded with the revoke")
    .action(async (opts: Record<string, unknown>) => {
      const result = await unenroll(
        {
          token: opts["token"] as string | undefined,
          org: opts["org"] as string | undefined,
          workspace: opts["workspace"] as string | undefined,
          purge: opts["purge"] as boolean | undefined,
          reason: opts["reason"] as string | undefined,
        },
        deps,
      );
      if (!result.ok) process.exitCode = 1;
    });

  program
    .command("export")
    .description("Export a session from the local WAL")
    .option("--session <id>", "Claude Code session id or Tacho session uuid")
    .option("--format <fmt>", "tacho | trace | otlp", "tacho")
    .option("--out <file>", "Write to a file instead of stdout")
    .option("--list", "List sessions in the WAL")
    .action(async (opts: Record<string, unknown>) => {
      const ok = await exportCommand(
        {
          session: opts["session"] as string | undefined,
          format: opts["format"] as "tacho" | "trace" | "otlp",
          out: opts["out"] as string | undefined,
          list: opts["list"] as boolean | undefined,
        },
        deps,
      );
      if (!ok) process.exitCode = 1;
    });

  program
    .command("verify")
    .description("Run one headless Claude Code turn and confirm it was chained")
    .action(async () => {
      const result = await verify({}, deps);
      deps.out(result.ok ? `OK: ${result.detail}` : `FAILED: ${result.detail}`);
      if (!result.ok) process.exitCode = 1;
    });

  program
    .command("daemon")
    .description("Run tachod in the foreground (what the service runs)")
    .action(async () => {
      const daemon = await startDaemon({ paths: deps.paths });
      const stop = () => {
        daemon
          .stop()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      await new Promise(() => undefined);
    });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  await buildTachoProgram().parseAsync(argv);
}

if (
  process.argv[1] !== undefined &&
  /tacho(\.mjs|\/main\.ts)?$/.test(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(
      `tacho: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
