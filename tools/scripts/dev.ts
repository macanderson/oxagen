#!/usr/bin/env tsx
import { execa } from "execa";
import kleur from "kleur";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeEnvPins } from "./lib/pin-env";
import { startStripeTunnel } from "./stripe-tunnel";
import { startInngestDevServer } from "./inngest-dev";
import { formatError } from "./lib/format-error";

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
          "(project oxagen-v2-app, scope oxagen), then `pnpm env:pull`.",
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

interface ContainerState {
  service: string;
  health: string;
  state: string;
}

async function readContainerStates(): Promise<ContainerState[]> {
  const { stdout } = await execa("docker", [
    "compose",
    "-f",
    COMPOSE_FILE,
    "ps",
    "--format",
    "json",
  ]);
  // Compose emits one JSON object per line.
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const row = JSON.parse(line) as { Service?: string; Health?: string; State?: string };
        return { service: row.Service ?? "?", health: row.Health ?? "", state: row.State ?? "?" };
      } catch {
        return { service: "?", health: "", state: "?" };
      }
    });
}

// On failure, an opaque "timed out" is useless — a crash-looping datastore (e.g.
// a corrupt ClickHouse volume) hides its fatal error in its own logs. Dump the
// state table and the tail of each offending container so the root cause is on
// screen instead of needing a manual `docker logs` archaeology dig.
async function dumpDiagnostics(states: ContainerState[]): Promise<void> {
  console.error(kleur.red("[dev] container states:"));
  for (const s of states) {
    console.error(kleur.red(`  - ${s.service}: state=${s.state} health=${s.health || "<none>"}`));
  }
  const broken = states.filter(
    (s) => !(s.health === "healthy" || (s.health === "" && s.state === "running")),
  );
  for (const s of broken) {
    console.error(kleur.yellow(`\n[dev] last 40 log lines for ${s.service}:`));
    try {
      await execa("docker", ["compose", "-f", COMPOSE_FILE, "logs", "--no-color", "--tail", "40", s.service], {
        stdio: "inherit",
      });
    } catch {
      console.error(kleur.red(`[dev] could not read logs for ${s.service}`));
    }
  }
}

async function waitForHealthy(): Promise<void> {
  console.log(kleur.cyan("[dev] waiting for containers to report healthy"));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const states = await readContainerStates();
    // A container stuck in restarting/exited will never become healthy — bail
    // immediately with diagnostics rather than burning the full 60s deadline.
    const crashed = states.filter((s) => s.state === "restarting" || s.state === "exited");
    if (crashed.length > 0) {
      console.error(
        kleur.red(
          `[dev] container(s) crash-looping: ${crashed.map((s) => s.service).join(", ")}`,
        ),
      );
      await dumpDiagnostics(states);
      process.exit(1);
    }
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
  await dumpDiagnostics(await readContainerStates());
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

  // Deterministically mark the whole local stack as a developer machine so the
  // auth layer reliably relaxes its deployed-only controls (no email
  // verification, no mandatory OAuth-token-encryption key). Without this those
  // controls keyed off NODE_ENV, which next dev sets slightly late and tsx-run
  // services (api/mcp) never set — intermittently 403'ing local sign-in until an
  // unrelated recompile (OXA-1752). Never set on Vercel, so prod is unaffected.
  process.env.OXAGEN_LOCAL_DEV = "1";

  await ensureEnvFile();
  // .env.local is authoritative for the local stack. tsx/node --env-file
  // never overrides inherited shell env, so a stale `export DATABASE_URL=...`
  // in the launching terminal would silently retarget every migrate/seed/dev
  // child — pin the file's values before anything spawns.
  const envPath = resolve(ROOT, ".env.local");
  if (existsSync(envPath)) {
    const { assignments, overridden } = computeEnvPins(
      readFileSync(envPath, "utf8"),
      process.env,
    );
    Object.assign(process.env, assignments);
    if (overridden.length > 0) {
      console.warn(
        kleur.yellow(
          `[dev] shell env differed from .env.local and was repinned for: ` +
            `${overridden.join(", ")} — unset these in your terminal to silence this`,
        ),
      );
    }
  }
  await checkDocker();
  await up();
  await waitForHealthy();
  await migrate();
  // Open the Stripe test-mode webhook tunnel and export its signing secret
  // BEFORE turbo spawns the API, so local webhook signature verification works.
  await startStripeTunnel();
  // Start the Inngest dev server and force INNGEST_DEV=1 BEFORE turbo spawns the
  // API/app, so the runner's events (subagent fanouts, ingestion, video, …) are
  // consumed locally instead of vanishing toward Inngest Cloud.
  await startInngestDevServer();
  await turbo();
}

main().catch((err) => {
  console.error(kleur.red(formatError(err)));
  process.exit(1);
});
