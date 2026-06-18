#!/usr/bin/env tsx
import { execa } from "execa";
import kleur from "kleur";
import { resolve } from "node:path";
import { stopStripeTunnel } from "./stripe-tunnel";
import { stopInngestDevServer } from "./inngest-dev";

const COMPOSE_FILE = "docker-compose.dev.yml";
const withVolumes = process.argv.includes("--volumes");

// Scope the kill to processes whose command line references the repo's
// absolute path. Previous `pkill -f tsx` killed every tsx process on the
// machine — unrelated projects included. OXA-1350.
const REPO_ROOT = resolve(process.cwd());

async function bestEffort(cmd: string, args: string[]): Promise<void> {
  try {
    await execa(cmd, args, { stdio: "inherit" });
  } catch {
    console.log(kleur.yellow(`[kill] ${cmd} ${args.join(" ")} exited non-zero`));
  }
}

async function main(): Promise<void> {
  // Match tsx / node processes whose argv contains this repo's path.
  // `pgrep -f` matches against the full command line; `pkill -f` likewise.
  // Anchoring with the repo path means a tsx process for a different repo
  // is left alone.
  const pattern = `(tsx|node).*${REPO_ROOT.replace(/[/\\$.*+?()[\]{}^|]/g, "\\$&")}`;
  console.log(kleur.cyan(`[kill] stopping dev processes scoped to ${REPO_ROOT}`));
  await bestEffort("pkill", ["-f", pattern]);

  // The Stripe CLI and Inngest dev server are standalone Go binaries the
  // repo-scoped pkill above won't match — stop them via the pidfiles written by
  // `pnpm dev`.
  await stopStripeTunnel();
  await stopInngestDevServer();

  const downArgs = ["compose", "-f", COMPOSE_FILE, "down", "--remove-orphans"];
  if (withVolumes) downArgs.push("--volumes");
  console.log(kleur.cyan(`[kill] docker ${downArgs.join(" ")}`));
  await bestEffort("docker", downArgs);

  console.log(kleur.green("[kill] done"));
}

main();
