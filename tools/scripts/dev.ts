#!/usr/bin/env tsx
import { execa } from "execa";
import kleur from "kleur";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());
const COMPOSE_FILE = "docker-compose.dev.yml";

async function checkDocker(): Promise<void> {
  try {
    await execa("docker", ["info"], { stdio: "ignore" });
  } catch {
    console.error(kleur.red("Docker is not running. Start Docker Desktop and retry."));
    process.exit(1);
  }
}

function checkEnv(): void {
  // Spec §11: .env.local is the only secret-bearing file.
  if (!existsSync(resolve(ROOT, ".env.local"))) {
    console.error(
      kleur.red(".env.local missing. Copy .env.example to .env.local and fill values."),
    );
    process.exit(1);
  }
}

async function up(): Promise<void> {
  console.log(kleur.cyan("[dev] starting docker stack"));
  await execa("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d"], {
    stdio: "inherit",
  });
}

async function waitForHealthy(): Promise<void> {
  console.log(kleur.cyan("[dev] waiting for containers to report healthy"));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { stdout } = await execa("docker", [
      "compose",
      "-f",
      COMPOSE_FILE,
      "ps",
      "--format",
      "json",
    ]);
    // Compose emits one JSON object per line.
    const lines = stdout.split("\n").filter(Boolean);
    const states = lines.map((line) => {
      try {
        const row = JSON.parse(line) as { Service?: string; Health?: string; State?: string };
        return { service: row.Service, health: row.Health, state: row.State };
      } catch {
        return { service: "?", health: "?", state: "?" };
      }
    });
    const ready = states.every(
      (s) => s.health === "healthy" || (s.health === "" && s.state === "running"),
    );
    if (ready && states.length > 0) {
      console.log(kleur.green("[dev] all containers healthy"));
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.error(kleur.red("[dev] timed out waiting for containers"));
  process.exit(1);
}

async function migrate(): Promise<void> {
  console.log(kleur.cyan("[dev] running pnpm db:migrate"));
  await execa("pnpm", ["db:migrate"], { stdio: "inherit" });
}

async function turbo(): Promise<void> {
  console.log(kleur.cyan("[dev] starting turbo dev"));
  // @oxagen/cli is an Ink commander that exits 1 without a subcommand; excluded
  // from the long-running dev set. Invoke it ad-hoc via `pnpm cli <command>`.
  await execa(
    "pnpm",
    ["turbo", "dev", "--parallel", "--filter=!@oxagen/cli"],
    { stdio: "inherit" },
  );
}

async function main(): Promise<void> {
  checkEnv();
  await checkDocker();
  await up();
  await waitForHealthy();
  await migrate();
  await turbo();
}

main().catch((err) => {
  console.error(kleur.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
