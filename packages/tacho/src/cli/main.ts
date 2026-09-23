/**
 * `tacho` entry: enroll, status, unenroll, export, verify, run, daemon.
 * `oxagen tacho <command>` in the platform CLI delegates here with its own
 * credentials.
 */
import { Command } from "commander";
import { runHookProcess } from "../claude-code/hook-process";
import { runDaemonProcess } from "../collector/run";
import { addArpCommands } from "./arp";
import {
  credentialIssue,
  credentialStatus,
  parseCredentialMode,
} from "./credential";
import { defaultCliDeps, isNativeBuild } from "./deps";
import { detect } from "./detect";
import { enroll, parseHarnesses } from "./enroll";
import { exportCommand } from "./export";
import { runMcpStdio } from "./mcp-stdio";
import { reassign } from "./reassign";
import { runContained } from "./run";
import { status } from "./status";
import { unenroll } from "./unenroll";
import { verify } from "./verify";

export function buildTachoProgram(): Command {
  const program = new Command();
  const deps = defaultCliDeps();
  program
    .name("tacho")
    .description(
      "Tacho: put this machine's agent sessions (Claude Code, Codex, Stella, custom agents) under Oxagen control",
    )
    .version(deps.wrapperVersion);

  program
    .command("mcp-stdio")
    .description(
      "Serve this machine's Oxagen toolbelt to a connected app over stdio (written into the app's MCP config by `tacho enroll`; not meant to be run by hand)",
    )
    .option(
      "--enrollment <id>",
      "The enrollment this config entry was written for",
    )
    .option("--port <n>", "The collector's loopback port", (v) => Number(v))
    .action(async (options: { enrollment?: string; port?: number }) => {
      process.exitCode = await runMcpStdio(options, {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
        fetch: globalThis.fetch,
      });
    });

  program
    .command("enroll")
    .description(
      "Enroll this machine: device key, host API key, tachod service, harness hooks",
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
    // No commander default: `enroll()` hooks claude-code on a fresh
    // enrollment by itself, and on an enrolled host an absent flag must mean
    // "keep the current list", not "add claude-code" (a Codex-only host
    // running a bare `tacho enroll` would otherwise gain Claude Code hooks).
    .option(
      "--harness <list>",
      "Harnesses to hook: claude-code (default on a fresh enrollment), codex, cursor, stella, or a comma list such as claude-code,stella",
    )
    .option(
      "--credentials <mode>",
      "brokered (default): the gateway holds each model vendor key and the harness holds a run token; passthrough: the harness keeps its own key",
    )
    .option("--verify", "Run a headless Claude Code turn afterwards")
    .action(async (opts: Record<string, unknown>) => {
      const harness = opts["harness"] as string | undefined;
      const result = await enroll(
        {
          credentials: parseCredentialMode(
            opts["credentials"] as string | undefined,
          ),
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
          ...(harness !== undefined
            ? { harnesses: parseHarnesses(harness) }
            : {}),
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

  const credential = program
    .command("credential")
    .description(
      "The gateway's custody of model credentials: issue a run token, or say what is held (never the secret)",
    );
  credential
    .command("issue")
    .description(
      "Print one run token for a harness (what Claude Code runs as its apiKeyHelper; not meant to be run by hand)",
    )
    .requiredOption("--harness <name>", "claude-code | codex")
    .option(
      "--static",
      "A static placement, bounded by the enrollment's expiry",
    )
    .action(async (opts: { harness: string; static?: boolean }) => {
      const result = await credentialIssue(
        {
          harness: opts.harness,
          ...(opts.static === true ? { placement: "static" as const } : {}),
        },
        deps,
      );
      if (result.ok && result.token !== undefined) {
        process.stdout.write(`${result.token}\n`);
        if (!result.detail.startsWith("issued by"))
          deps.err(`tacho credential: ${result.detail}`);
        return;
      }
      deps.err(`tacho credential: ${result.detail}`);
      process.exitCode = 1;
    });
  credential
    .command("status")
    .description(
      "Which providers the gateway holds, and how each harness gets its credential",
    )
    .option("--json", "Machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      await credentialStatus(
        { ...(opts.json !== undefined ? { json: opts.json } : {}) },
        deps,
      );
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
    .command("reassign")
    .description(
      "Point this host at another workspace (or org): revoke, then enroll again keeping the device key",
    )
    .option("--workspace <slug>", "Workspace slug to report to")
    .option("--org <slug>", "Organization slug (default: the current one)")
    .option("--token <apiKey>", "Oxagen API token (or run `oxagen login`)")
    .option("--api-url <url>", "Oxagen API base URL")
    .option(
      "--harness <list>",
      "Replace the harness list (default: keep the current one)",
    )
    .option("--reason <text>", "Reason recorded with the revoke")
    .action(async (opts: Record<string, unknown>) => {
      const harness = opts["harness"] as string | undefined;
      const result = await reassign(
        {
          token: opts["token"] as string | undefined,
          org: opts["org"] as string | undefined,
          workspace: opts["workspace"] as string | undefined,
          apiUrl: opts["apiUrl"] as string | undefined,
          reason: opts["reason"] as string | undefined,
          ...(harness !== undefined
            ? { harnesses: parseHarnesses(harness) }
            : {}),
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
    .description(
      "Run one headless turn (Claude Code by default, --harness codex, cursor or stella) and confirm it was chained",
    )
    .option(
      "--harness <name>",
      "claude-code | codex | cursor | stella",
      "claude-code",
    )
    .option("--json", "Machine-readable result")
    .action(async (opts: { harness?: string; json?: boolean }) => {
      const [harness] = parseHarnesses(opts.harness);
      const result = await verify(
        harness !== undefined ? { harness } : {},
        deps,
      );
      if (opts.json === true) deps.out(JSON.stringify(result));
      else
        deps.out(
          result.ok ? `OK: ${result.detail}` : `FAILED: ${result.detail}`,
        );
      if (!result.ok) process.exitCode = 1;
    });

  program
    .command("run")
    .description(
      "Start one agent run under the contained launcher: `tacho run --contained -- claude -p <task>` (Linux and Docker; ADR-152)",
    )
    .requiredOption(
      "--contained",
      "Run inside the measured container, whose only exits are the gateway and the Oxagen API",
    )
    .option("--image <ref>", "The contained image (or OXAGEN_CONTAINED_IMAGE)")
    .option(
      "--workspace <dir>",
      "The repository root to mount at /workspace (default: the current directory)",
    )
    .option(
      "--github-repository <owner/name>",
      "The one repository the run may reach, with a token in OXAGEN_CONTAINED_GITHUB_TOKEN",
    )
    .argument("<agent>", "claude or codex")
    .argument("[args...]", "Arguments for the agent, after --")
    .action(
      async (
        agent: string,
        args: string[],
        opts: {
          image?: string;
          workspace?: string;
          githubRepository?: string;
        },
      ) => {
        const controller = new AbortController();
        for (const signal of ["SIGINT", "SIGTERM"] as const)
          process.once(signal, () => controller.abort());
        process.exitCode = await runContained(
          {
            agent,
            args,
            ...(opts.image !== undefined ? { image: opts.image } : {}),
            ...(opts.workspace !== undefined
              ? { workspace: opts.workspace }
              : {}),
            ...(opts.githubRepository !== undefined
              ? { githubRepository: opts.githubRepository }
              : {}),
          },
          {
            ...deps,
            cwd: process.cwd(),
            signal: controller.signal,
            write: (stream, text) =>
              (stream === "stdout" ? process.stdout : process.stderr).write(
                text,
              ),
          },
        );
      },
    );

  program
    .command("detect")
    .description(
      "Which harnesses this machine has (claude, codex, cursor-agent, stella) and which are enrolled",
    )
    .option("--json", "Machine-readable output")
    .action((opts: { json?: boolean }) => {
      detect({ ...(opts.json !== undefined ? { json: opts.json } : {}) }, deps);
    });

  program
    .command("daemon")
    .description("Run tachod in the foreground (what the service runs)")
    .action(async () => {
      await runDaemonProcess();
    });

  // The command hook, for the compiled single binary where there is no
  // sibling `tacho-hook`. Flags (`--enrollment`, `--harness`, `--agent`) are
  // read from argv by the hook itself, so commander must let them through
  // untouched.
  program
    .command("hook")
    .description(
      "Run as the command hook: reads the hook payload on stdin and prints the answer. --harness claude-code|codex|cursor|stella names the harness that ran it; --agent <name> records a custom agent that sends Claude Code-shaped payloads (lowercase letters, digits, '.', '_', '-'; wins over --harness)",
    )
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      await runHookProcess(process.argv);
    });

  addArpCommands(program, deps);
  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  await buildTachoProgram().parseAsync(argv);
}

// The native (SEA) build has its own entry that calls `main()`; this guard is
// for `bin/tacho.mjs` and `tsx src/cli/main.ts`.
if (
  !isNativeBuild() &&
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
