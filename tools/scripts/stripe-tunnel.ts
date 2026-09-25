#!/usr/bin/env tsx
/**
 * Stripe webhook tunnel lifecycle, shared by `pnpm dev` and `pnpm kill`.
 *
 * In test mode there is no public URL Stripe can reach, so the Stripe CLI's
 * `stripe listen` opens a tunnel and forwards live test-mode events to the
 * local API webhook route (`/webhooks/stripe`, mounted in apps/api/src/app.ts
 * on PORTS.api). The signing secret `stripe listen` uses is NOT the dashboard
 * endpoint secret stored in `.env.local` — it's a per-device CLI secret — so we
 * also fetch it via `--print-secret` and export it as STRIPE_WEBHOOK_SECRET
 * BEFORE turbo spawns the API. Node's `--env-file` yields to an already-set
 * process.env value, so the API's `--env-file=.env.local` will not clobber it
 * and local signature verification (`verifyStripeSignature`) passes.
 *
 * `stripe listen` runs detached (like `docker compose up -d`) so Ctrl-C on the
 * foreground turbo process leaves the tunnel alive; `pnpm kill` tears it down
 * via the pidfile.
 */
import { execa } from "execa";
import { execFileSync, spawn } from "node:child_process";
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
export const STRIPE_PID_FILE = resolve(ROOT, ".stripe-listen.pid");
export const STRIPE_LOG_FILE = resolve(ROOT, ".stripe-listen.log");

// apps/api mounts the Stripe webhook at /webhooks/stripe on PORTS.api (4000).
const FORWARD_TO = `localhost:${PORTS.api}/webhooks/stripe`;

async function stripeInstalled(): Promise<boolean> {
  try {
    await execa("stripe", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the command line of a live process, or null when no process
 * holds that pid. `ps -p <pid> -o command=` prints nothing and exits non-zero
 * for a pid that is gone.
 */
export type ReadCommandLine = (pid: number) => string | null;

const readCommandLine: ReadCommandLine = (pid) => {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};

/**
 * True only when `pid` is a live `stripe listen` process. The pidfile outlives
 * the tunnel after a reboot or a crash, and the operating system reuses pids,
 * so a bare liveness probe can name an unrelated process. `stopStripeTunnel`
 * signals the whole process group, so it must confirm the pid first.
 */
export function isStripeTunnelPid(
  pid: number,
  readCmd: ReadCommandLine = readCommandLine,
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const command = readCmd(pid);
  if (!command) return false;
  const [program = "", ...args] = command.split(/\s+/);
  const name = program.split("/").pop();
  return (
    (name === "stripe" || name === "stripe.exe") && args.includes("listen")
  );
}

function readPidFile(pidFile: string): number {
  return Number(readFileSync(pidFile, "utf8").trim());
}

export function tunnelAlreadyRunning(
  pidFile: string = STRIPE_PID_FILE,
  readCmd: ReadCommandLine = readCommandLine,
): boolean {
  if (!existsSync(pidFile)) return false;
  if (isStripeTunnelPid(readPidFile(pidFile), readCmd)) return true;
  rmSync(pidFile, { force: true }); // stale pidfile: gone, or a reused pid
  return false;
}

/**
 * Start the Stripe test-mode webhook tunnel and export its signing secret.
 * Never throws or exits — a missing CLI or absent login degrades to a warning
 * so `pnpm dev` still brings the rest of the stack up.
 */
export async function startStripeTunnel(): Promise<void> {
  if (!(await stripeInstalled())) {
    console.log(
      kleur.yellow(
        "[dev] stripe CLI not found — skipping webhook tunnel. " +
          "Install it (`brew install stripe/stripe-cli/stripe`) and `stripe login` to test webhooks.",
      ),
    );
    return;
  }

  if (tunnelAlreadyRunning()) {
    console.log(
      kleur.cyan(
        "[dev] stripe listen already running — reusing existing tunnel",
      ),
    );
    return;
  }

  // The per-device CLI signing secret. Requires `stripe login`; if the user
  // isn't authed this fails and we skip the tunnel rather than block dev.
  let secret: string;
  try {
    const { stdout } = await execa("stripe", ["listen", "--print-secret"]);
    secret = stdout.trim();
  } catch {
    console.log(
      kleur.yellow(
        "[dev] could not read stripe signing secret — run `stripe login`, then `pnpm dev` again to enable webhooks.",
      ),
    );
    return;
  }

  if (!secret.startsWith("whsec_")) {
    console.log(
      kleur.yellow(
        `[dev] unexpected stripe secret format — skipping webhook tunnel`,
      ),
    );
    return;
  }

  // Export BEFORE turbo spawns the API so verifyStripeSignature() validates
  // against the CLI secret (not the dashboard secret in .env.local).
  process.env.STRIPE_WEBHOOK_SECRET = secret;

  // Detached so the foreground turbo process can own the terminal; logs go to
  // a file `pnpm kill` and the user can tail. stdio detached needs an fd, not
  // "inherit", or the child dies with the parent's stdout.
  const out = openSync(STRIPE_LOG_FILE, "a");
  const child = spawn("stripe", ["listen", "--forward-to", FORWARD_TO], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  if (child.pid) writeFileSync(STRIPE_PID_FILE, String(child.pid));

  console.log(
    kleur.green(
      `[dev] stripe webhook tunnel → http://${FORWARD_TO} (logs: ${STRIPE_LOG_FILE})`,
    ),
  );
}

/**
 * Stop the Stripe webhook tunnel started by `startStripeTunnel`. Best-effort,
 * never throws. It signals nothing unless the pidfile still names a live
 * `stripe listen` process, and it removes the pidfile either way.
 */
export async function stopStripeTunnel(
  pidFile: string = STRIPE_PID_FILE,
  readCmd: ReadCommandLine = readCommandLine,
): Promise<void> {
  if (!existsSync(pidFile)) return;
  const pid = readPidFile(pidFile);
  if (isStripeTunnelPid(pid, readCmd)) {
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
    console.log(kleur.cyan(`[kill] stopped stripe listen (pid ${pid})`));
  }
  rmSync(pidFile, { force: true });
}
