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
    console.log(
      kleur.yellow(`[kill] ${cmd} ${args.join(" ")} exited non-zero`),
    );
  }
}

// Storybook (apps/app on 6007, packages/ui on 6008) spawns a Vite preview
// child that can outlive the repo-scoped pkill above; free the ports directly
// so the next `pnpm dev` never trips a "port already in use". Only listeners on
// these two ports are touched — no other process is affected.
const STORYBOOK_PORTS = [6007, 6008] as const;

async function killStorybookPorts(): Promise<void> {
  for (const port of STORYBOOK_PORTS) {
    let pids: string[] = [];
    try {
      const { stdout } = await execa("lsof", ["-ti", `tcp:${port}`]);
      pids = stdout
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean);
    } catch {
      // lsof exits non-zero when nothing is listening — nothing to kill.
      continue;
    }
    if (pids.length === 0) continue;
    console.log(
      kleur.cyan(
        `[kill] freeing storybook port ${port} (pids: ${pids.join(", ")})`,
      ),
    );
    await bestEffort("kill", ["-9", ...pids]);
  }
}

async function main(): Promise<void> {
  // Match tsx / node processes whose argv contains this repo's path.
  // `pgrep -f` matches against the full command line; `pkill -f` likewise.
  // Anchoring with the repo path means a tsx process for a different repo
  // is left alone.
  const pattern = `(tsx|node).*${REPO_ROOT.replace(/[/\\$.*+?()[\]{}^|]/g, "\\$&")}`;
  console.log(
    kleur.cyan(`[kill] stopping dev processes scoped to ${REPO_ROOT}`),
  );
  await bestEffort("pkill", ["-f", pattern]);

  // Free the Storybook ports (apps/app 6007, packages/ui 6008) explicitly.
  await killStorybookPorts();

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
