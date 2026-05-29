#!/usr/bin/env tsx
import { execa } from "execa";
import kleur from "kleur";

const COMPOSE_FILE = "docker-compose.dev.yml";

async function checkDocker(): Promise<void> {
  try {
    await execa("docker", ["info"], { stdio: "ignore" });
  } catch {
    console.error(kleur.red("Docker is not running. Start Docker Desktop and retry."));
    process.exit(1);
  }
}

async function checkEnv(): Promise<void> {
  // Secrets live in Doppler (project: oxagen). The dev script is invoked via
  // `doppler run -- tsx tools/scripts/dev.ts` so by the time we get here, the
  // expected variables should already be in process.env. We sanity-check one
  // canonical secret so a missing/misconfigured Doppler context fails loud.
  if (!process.env.DATABASE_URL) {
    console.error(
      kleur.red(
        "DATABASE_URL not set. Run `doppler setup` (project oxagen, config dev_personal) " +
          "and invoke pnpm dev so commands wrap in `doppler run --`.",
      ),
    );
    process.exit(1);
  }
  try {
    await execa("doppler", ["me"], { stdio: "ignore" });
  } catch {
    console.error(
      kleur.red("Doppler CLI not authenticated. Run `doppler login` then `doppler setup`."),
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
  await checkEnv();
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
