#!/usr/bin/env tsx
import { execa } from "execa";
import kleur from "kleur";

const COMPOSE_FILE = "docker-compose.dev.yml";
const withVolumes = process.argv.includes("--volumes");

async function bestEffort(cmd: string, args: string[]): Promise<void> {
  try {
    await execa(cmd, args, { stdio: "inherit" });
  } catch {
    // Best-effort: log and continue so the rest of the teardown still runs.
    console.log(kleur.yellow(`[kill] ${cmd} ${args.join(" ")} exited non-zero`));
  }
}

async function main(): Promise<void> {
  console.log(kleur.cyan("[kill] stopping tsx app processes"));
  await bestEffort("pkill", ["-f", "tsx"]);

  const downArgs = ["compose", "-f", COMPOSE_FILE, "down", "--remove-orphans"];
  if (withVolumes) downArgs.push("--volumes");
  console.log(kleur.cyan(`[kill] docker ${downArgs.join(" ")}`));
  await bestEffort("docker", downArgs);

  console.log(kleur.green("[kill] done"));
}

main();
