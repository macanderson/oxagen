#!/usr/bin/env tsx
/**
 * Inngest dev server lifecycle, shared by `pnpm dev` and `pnpm kill`.
 *
 * Inngest is how every async/durable capability actually runs locally: the
 * runner emits events (e.g. `agent/subagent.dispatch`) via the Inngest SDK, and
 * the dev server is what RECEIVES those events and invokes the matching
 * functions served by apps/api at `/api/inngest`. Without it, a dispatched
 * fanout inserts its `subagent_runs` rows, emits the event, and then sits at
 * `status:"pending"` forever because nothing consumes the event — exactly the
 * "research swarms never start" symptom.
 *
 * The dev server is a standalone Go binary shipped via the `inngest-cli` npm
 * package (pinned in the root package.json for deterministic, offline-capable
 * startup). We run `inngest-cli dev -u <api>/api/inngest`:
 *   - `dev`  → in-memory dev server on :8288, no cloud account needed.
 *   - `-u`   → the app's serve endpoint to discover/sync functions from. The
 *              server polls this URL and retries until apps/api is up, so it is
 *              safe to start before turbo spawns the API.
 *
 * We also force `INNGEST_DEV=1` into the environment BEFORE turbo spawns the API
 * and app, so their Inngest SDK clients send events to the local dev server
 * (127.0.0.1:8288) and the serve handler skips signing-key verification, rather
 * than attempting to reach Inngest Cloud with the test keys in `.env.local`.
 *
 * Like the Stripe tunnel, the server runs detached (its own process group) so
 * Ctrl-C on the foreground turbo process leaves it alive; `pnpm kill` tears it
 * down via the pidfile.
 */
import { spawn } from "node:child_process";
import kleur from "kleur";
import {
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { PORTS } from "@oxagen/config";

const ROOT = resolve(process.cwd());
export const INNGEST_PID_FILE = resolve(ROOT, ".inngest-dev.pid");
export const INNGEST_LOG_FILE = resolve(ROOT, ".inngest-dev.log");

// apps/api mounts the Inngest serve handler at /api/inngest on PORTS.api (4000).
const DISCOVERY_URL = `http://127.0.0.1:${PORTS.api}/api/inngest`;

// Resolve the pinned inngest-cli binary. The npm package ships a JS placeholder
// at bin/inngest that its postinstall REPLACES with a platform Go binary, which
// makes pnpm's generated `.bin/inngest-cli` shim unreliable (it can bake a
// `node`-interpreter wrapper around what becomes a native binary). So we point
// straight at the package's own bin via the stable top-level symlink — this is
// the actual Mach-O/ELF executable and is not version-pinned in the path.
const INNGEST_BIN = resolve(ROOT, "node_modules/inngest-cli/bin/inngest");

function devServerAlreadyRunning(): boolean {
  if (!existsSync(INNGEST_PID_FILE)) return false;
  const pid = Number(readFileSync(INNGEST_PID_FILE, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 == liveness probe, throws if gone
    return true;
  } catch {
    rmSync(INNGEST_PID_FILE, { force: true }); // stale pidfile
    return false;
  }
}

/**
 * Start the local Inngest dev server and point the runner at it. Never throws
 * or exits — a missing binary degrades to a warning so `pnpm dev` still brings
 * the rest of the stack up (async capabilities just won't run until it's there).
 */
export async function startInngestDevServer(): Promise<void> {
  // Force the SDK into dev mode for every child turbo spawns. Set BEFORE turbo
  // so apps/api + apps/app send events to the local dev server instead of cloud.
  // Node's `--env-file` yields to an already-set process.env value, so the
  // children's `--env-file=.env.local` will not clobber this.
  process.env.INNGEST_DEV ??= "1";

  if (devServerAlreadyRunning()) {
    console.log(
      kleur.cyan("[dev] inngest dev server already running — reusing it"),
    );
    return;
  }

  const bin = existsSync(INNGEST_BIN) ? INNGEST_BIN : "inngest-cli";

  // Detached so the foreground turbo process can own the terminal; logs go to a
  // file the user can tail and `pnpm kill` ignores. stdio detached needs an fd,
  // not "inherit", or the child dies with the parent's stdout.
  const out = openSync(INNGEST_LOG_FILE, "a");
  let child;
  try {
    child = spawn(bin, ["dev", "-u", DISCOVERY_URL], {
      detached: true,
      stdio: ["ignore", out, out],
    });
  } catch {
    console.log(
      kleur.yellow(
        "[dev] inngest-cli not found — skipping dev server. " +
          "Run `pnpm i` (it is a pinned devDependency), then `pnpm dev` again. " +
          "Async capabilities (subagent fanouts, ingestion, video) will not run without it.",
      ),
    );
    return;
  }

  // A binary that exits immediately (e.g. missing native build) should warn,
  // not silently leave a dead pidfile.
  child.on("error", (err) => {
    console.log(
      kleur.yellow(`[dev] inngest dev server failed to launch: ${err.message}`),
    );
  });

  child.unref();
  if (child.pid) writeFileSync(INNGEST_PID_FILE, String(child.pid));

  console.log(
    kleur.green(
      `[dev] inngest dev server → http://127.0.0.1:8288 (discovering ${DISCOVERY_URL}, logs: ${INNGEST_LOG_FILE})`,
    ),
  );
}

/**
 * Stop the Inngest dev server started by `startInngestDevServer`. Best-effort,
 * never throws.
 */
export async function stopInngestDevServer(): Promise<void> {
  if (!existsSync(INNGEST_PID_FILE)) return;
  const pid = Number(readFileSync(INNGEST_PID_FILE, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0) {
    // detached child is its own process-group leader; negative pid kills the
    // whole group. Fall back to the bare pid if that fails.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    console.log(kleur.cyan(`[kill] stopped inngest dev server (pid ${pid})`));
  }
  rmSync(INNGEST_PID_FILE, { force: true });
}
