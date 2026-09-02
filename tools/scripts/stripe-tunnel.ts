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

function tunnelAlreadyRunning(): boolean {
  if (!existsSync(STRIPE_PID_FILE)) return false;
  const pid = Number(readFileSync(STRIPE_PID_FILE, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 == liveness probe, throws if gone
    return true;
  } catch {
    rmSync(STRIPE_PID_FILE, { force: true }); // stale pidfile
    return false;
  }
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
 * never throws.
 */
export async function stopStripeTunnel(): Promise<void> {
  if (!existsSync(STRIPE_PID_FILE)) return;
  const pid = Number(readFileSync(STRIPE_PID_FILE, "utf8").trim());
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
    console.log(kleur.cyan(`[kill] stopped stripe listen (pid ${pid})`));
  }
  rmSync(STRIPE_PID_FILE, { force: true });
}
