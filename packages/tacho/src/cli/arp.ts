import { type Command, Option } from "commander";
import { verifyBundle } from "../arp/bundle";
import { captureCheckpoint, prepareCheckpoint } from "../arp/transfer";
import { type CliDeps, defaultCliDeps } from "./deps";

type ArpOutput = Pick<CliDeps, "out" | "err">;

export function addArpCommands(
  program: Command,
  deps: ArpOutput = defaultCliDeps(),
): void {
  const arp = program
    .command("arp")
    .description("Capture and prepare local Agent Run Protocol checkpoints");

  async function report(operation: () => unknown | Promise<unknown>) {
    try {
      deps.out(JSON.stringify(await operation()));
    } catch (error) {
      deps.err(
        `tacho arp: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
  }

  arp
    .command("capture")
    .description("Sign selected files and a brief at a stopped turn boundary")
    .requiredOption("--workspace <directory>", "Stopped source workspace")
    .requiredOption("--evidence <file>", "Tacho export ending at turn_end")
    .requiredOption(
      "--brief <file>",
      "Transfer brief and explicit file selection",
    )
    .requiredOption("--out <directory>", "New checkpoint directory")
    .requiredOption("--key <file>", "Checkpoint signing key file")
    .requiredOption(
      "--attest-boundary",
      "Attest that the stopped workspace matches the evidence boundary",
    )
    .action(
      async (opts: {
        workspace: string;
        evidence: string;
        brief: string;
        out: string;
        key: string;
        attestBoundary: boolean;
      }) => {
        await report(() =>
          captureCheckpoint({
            workspace: opts.workspace,
            evidenceFile: opts.evidence,
            briefFile: opts.brief,
            out: opts.out,
            keyFile: opts.key,
            attestBoundary: opts.attestBoundary === true,
          }),
        );
      },
    );

  arp
    .command("verify")
    .description("Check checkpoint integrity against a pinned public key")
    .requiredOption("--bundle <directory>", "Checkpoint directory")
    .requiredOption("--public-key <key>", "Trusted checkpoint public key")
    .action(async (opts: { bundle: string; publicKey: string }) => {
      await report(async () => {
        const verified = await verifyBundle(opts.bundle, opts.publicKey);
        return { checkpointDigest: verified.checkpointDigest };
      });
    });

  arp
    .command("prepare")
    .description("Restore selected files and write a prompt for a fresh run")
    .requiredOption("--bundle <directory>", "Checkpoint directory")
    .requiredOption("--destination <directory>", "New preparation directory")
    .requiredOption("--public-key <key>", "Trusted checkpoint public key")
    .addOption(
      new Option("--harness <name>", "Destination harness")
        .choices(["claude-code", "codex", "cursor", "stella"])
        .makeOptionMandatory(),
    )
    .action(
      async (opts: {
        bundle: string;
        destination: string;
        publicKey: string;
        harness: "claude-code" | "codex" | "cursor" | "stella";
      }) => {
        await report(() => prepareCheckpoint(opts));
      },
    );
}
