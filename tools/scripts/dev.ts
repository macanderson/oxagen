#!/usr/bin/env tsx
import { execa } from "execa";
import kleur from "kleur";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { startStripeTunnel } from "./stripe-tunnel";

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

async function ensureEnvFile(): Promise<void> {
  // Vercel is the source of truth for env vars. `.env.local` is hydrated from
  // the linked project's Development environment via `vercel env pull`.
  // If absent, we bootstrap it here so first-time setup is one command.
  const envPath = resolve(ROOT, ".env.local");
  if (existsSync(envPath)) return;

  console.log(kleur.cyan("[dev] .env.local missing — running `pnpm env:pull`"));
  try {
    await execa("pnpm", ["env:pull"], { stdio: "inherit" });
  } catch {
    console.error(
      kleur.red(
        "Failed to pull env from Vercel. Run `vercel login` and `vercel link` " +
          "(project oxagen-v2-app, scope 02beta), then `pnpm env:pull`.",
      ),
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
  // @oxagen/cli is an Ink commander that exits 1 without a subcommand, and
  // @oxagen/env-manager is an on-demand local tool (`pnpm env:manager`); both
  // are excluded from the long-running dev set. Invoke the cli ad-hoc via
  // `pnpm cli <command>`. Turbo 2 runs `persistent: true` tasks (see turbo.json)
  // in parallel by default — no --parallel flag needed.
  await execa(
    "pnpm",
    ["turbo", "dev", "--filter=!@oxagen/cli", "--filter=!@oxagen/env-manager"],
    { stdio: "inherit" },
  );
}

async function main(): Promise<void> {
  // The shell (or a Vercel-pulled .env) may export over-quoted values — e.g.
  // NODE_ENV='"development"' — which every spawned dev server (Next, api, mcp)
  // inherits, producing Next's "non-standard NODE_ENV" warning and @oxagen/config
  // normalizeEnv-stripped warnings on boot. Strip one surrounding double-quote
  // pair from every value here so the children see clean env.
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      process.env[key] = value.slice(1, -1);
    }
  }
  await ensureEnvFile();
  await checkDocker();
  await up();
  await waitForHealthy();
  await migrate();
  // Open the Stripe test-mode webhook tunnel and export its signing secret
  // BEFORE turbo spawns the API, so local webhook signature verification works.
  await startStripeTunnel();
  await turbo();
}

main().catch((err) => {
  console.error(kleur.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
