#!/usr/bin/env tsx
import { execa } from "execa";
import kleur from "kleur";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closeClickhouse } from "@oxagen/telemetry";
import { computeEnvPins } from "./lib/pin-env";
import { createDevLogShipper, type DevLogShipper } from "./lib/dev-log-shipper";
import { startStripeTunnel } from "./stripe-tunnel";
import { startInngestDevServer } from "./inngest-dev";
import { formatError } from "./lib/format-error";
import { inspectAppPorts, type AppPort } from "./lib/preflight-ports";
import {
  guardTurbopackCaches,
  markCleanShutdown,
} from "./lib/next-cache-guard";

const ROOT = resolve(process.cwd());
const COMPOSE_FILE = "docker-compose.dev.yml";

// Before touching anything, check whether the app servers are already bound.
// `pnpm dev` is run repeatedly and in parallel against this one repo; without
// this guard a second launch pushes through docker-up + migrate, spawns a
// duplicate Stripe tunnel and Inngest dev server, and finally crashes turbo with
// a raw `EADDRINUSE` stack trace from the app. Detect that up front and exit with
// an actionable message instead — and never disturb the running stack.
async function preflightAppPorts(): Promise<void> {
  const result = await inspectAppPorts();
  if (result.status === "clean") return;

  const list = (ports: AppPort[]): string =>
    ports.map((p) => `${p.name} :${p.port}`).join(", ");
  const killHint =
    "[dev] to restart cleanly run `pnpm kill` then `pnpm dev` — note `pnpm kill` also stops the " +
    "shared Docker datastores other sessions of this repo may be using.";

  if (result.status === "running") {
    console.log(
      kleur.green(
        `[dev] the local dev stack is already running (${list(result.bound)}).`,
      ),
    );
    console.log(
      kleur.cyan("[dev] reuse it at http://localhost:3000 — nothing to start."),
    );
    console.log(kleur.dim(killHint));
    process.exit(0);
  }

  // Partial / wedged: some app ports bound, some free — a second launch can't
  // cleanly take over. Surface it as an error so the developer resolves it.
  console.error(
    kleur.yellow(
      `[dev] a partial dev stack is already up — bound: ${list(result.bound)}; free: ${list(result.free)}.`,
    ),
  );
  console.error(
    kleur.cyan(
      "[dev] this is a wedged state; a fresh launch would crash on the bound ports.",
    ),
  );
  console.error(kleur.dim(killHint));
  process.exit(1);
}

async function checkDocker(): Promise<void> {
  try {
    await execa("docker", ["info"], { stdio: "ignore" });
  } catch {
    console.error(
      kleur.red("Docker is not running. Start Docker Desktop and retry."),
    );
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
        const row = JSON.parse(line) as {
          Service?: string;
          Health?: string;
          State?: string;
        };
        return {
          service: row.Service ?? "?",
          health: row.Health ?? "",
          state: row.State ?? "?",
        };
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
    console.error(
      kleur.red(
        `  - ${s.service}: state=${s.state} health=${s.health || "<none>"}`,
      ),
    );
  }
  const broken = states.filter(
    (s) =>
      !(s.health === "healthy" || (s.health === "" && s.state === "running")),
  );
  for (const s of broken) {
    console.error(kleur.yellow(`\n[dev] last 40 log lines for ${s.service}:`));
    try {
      await execa(
        "docker",
        [
          "compose",
          "-f",
          COMPOSE_FILE,
          "logs",
          "--no-color",
          "--tail",
          "40",
          s.service,
        ],
        {
          stdio: "inherit",
        },
      );
    } catch {
      console.error(kleur.red(`[dev] could not read logs for ${s.service}`));
    }
  }
}

async function waitForHealthy(): Promise<void> {
  console.log(kleur.cyan("[dev] waiting for containers to report healthy"));
  // Neo4j's first boot on a fresh volume (APOC install + store init) takes
  // 60–90s, so the deadline must comfortably exceed that; crash-looping
  // containers still bail out early below rather than waiting this long.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const states = await readContainerStates();
    // A container stuck in restarting/exited will never become healthy — bail
    // immediately with diagnostics rather than burning the full 180s deadline.
    const crashed = states.filter(
      (s) => s.state === "restarting" || s.state === "exited",
    );
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
      (s) =>
        s.health === "healthy" || (s.health === "" && s.state === "running"),
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

// Tee one of turbo's output streams: write every byte straight to our terminal
// (preserving ANSI colors) AND hand each complete line to the ClickHouse shipper.
function tapStream(
  readable: NodeJS.ReadableStream | null,
  out: NodeJS.WriteStream,
  stream: "stdout" | "stderr",
  shipper: DevLogShipper,
): void {
  if (!readable) return;
  let buf = "";
  readable.on("data", (chunk: Buffer) => {
    out.write(chunk);
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      shipper.push(stream, buf.slice(0, idx).replace(/\r$/, ""));
      buf = buf.slice(idx + 1);
    }
  });
  readable.on("end", () => {
    if (buf.length > 0) shipper.push(stream, buf.replace(/\r$/, ""));
  });
}

async function turbo(): Promise<void> {
  console.log(kleur.cyan("[dev] starting turbo dev"));
  // @oxagen/cli is an Ink commander that exits 1 without a subcommand, and
  // @oxagen/env-manager is an on-demand local tool (`pnpm env:manager`); both
  // are excluded from the long-running dev set. Invoke the cli ad-hoc via
  // `pnpm cli <command>`. Turbo 2 runs `persistent: true` tasks (see turbo.json)
  // in parallel by default — no --parallel flag needed.
  //
  // We capture the combined output into the local ClickHouse `dev_logs` table so
  // the compile/runtime errors that scroll past in the terminal stay queryable.
  // That requires tapping the stream line-by-line, so we force turbo's `stream`
  // UI (turbo.json defaults to the interactive `tui`, which repaints the screen
  // and can't be tapped) and FORCE_COLOR so the teed terminal output stays
  // colored. Every line is still written verbatim to this process's
  // stdout/stderr — the only visible change is tui → prefixed stream lines.
  const devSession = randomUUID();
  console.log(
    kleur.dim(
      `[dev] mirroring logs to ClickHouse dev_logs (session ${devSession})`,
    ),
  );
  const shipper = createDevLogShipper(devSession);

  const sub = execa(
    "pnpm",
    [
      "turbo",
      "dev",
      "--ui=stream",
      "--filter=!@oxagen/cli",
      "--filter=!@oxagen/env-manager",
    ],
    {
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
      env: { FORCE_COLOR: "1" },
    },
  );

  tapStream(sub.stdout, process.stdout, "stdout", shipper);
  tapStream(sub.stderr, process.stderr, "stderr", shipper);

  // Forward SIGINT/SIGTERM to turbo and keep this process alive long enough
  // to observe the graceful shutdown — without these handlers Node dies on
  // the signal before the `finally` below (and the clean-shutdown marker)
  // ever runs.
  const forward = (sig: NodeJS.Signals): void => {
    sub.kill(sig);
  };
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);

  let graceful = false;
  try {
    await sub;
    graceful = true;
  } catch (err) {
    // A signal-terminated turbo (Ctrl-C, pnpm kill's SIGTERM) still shut its
    // children down in order — that counts as clean. Anything else (crash,
    // SIGKILL never reaches here) leaves the cache suspect.
    const signal = (err as { signal?: string }).signal;
    graceful = signal === "SIGINT" || signal === "SIGTERM";
  } finally {
    process.removeListener("SIGINT", forward);
    process.removeListener("SIGTERM", forward);
    // Flush the tail of the session and release the CH connection so the
    // process can exit cleanly on Ctrl-C / turbo shutdown.
    await shipper.close();
    await closeClickhouse();
  }
  if (graceful) markCleanShutdown(ROOT);
}

async function main(): Promise<void> {
  // Fail fast (and side-effect-free) if a stack is already running, before any
  // docker/migrate/tunnel/turbo work that would conflict or double-spawn.
  await preflightAppPorts();

  // The shell (or a Vercel-pulled .env) may export over-quoted values — e.g.
  // NODE_ENV='"development"' — which every spawned dev server (Next, api, mcp)
  // inherits, producing Next's "non-standard NODE_ENV" warning and @oxagen/config
  // normalizeEnv-stripped warnings on boot. Strip one surrounding double-quote
  // pair from every value here so the children see clean env.
  for (const [key, value] of Object.entries(process.env)) {
    if (
      typeof value === "string" &&
      value.length >= 2 &&
      value.startsWith('"') &&
      value.endsWith('"')
    ) {
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
  guardTurbopackCaches(ROOT, (app) =>
    console.log(
      kleur.yellow(
        `[dev] ${app}/.next was left by an unclean shutdown — clearing the Turbopack cache (a corrupt persisted manifest silently 404s real routes)`,
      ),
    ),
  );
  await turbo();
}

main().catch((err) => {
  console.error(kleur.red(formatError(err)));
  process.exit(1);
});
