#!/usr/bin/env node
// Resilient launcher for the @oxagen/bench-web dashboard (`pnpm eval:app`).
//
// `next dev --port 3200` hard-crashes with EADDRINUSE when 3200 is already
// taken (a leftover dev server is the common case). That left `pnpm eval:app`
// exiting non-zero with a raw stack trace and no remediation. This launcher
// instead:
//   1. prefers 3200 (override with PORT=...),
//   2. if 3200 is already serving THIS app, reports the live URL and exits 0
//      (re-running the command when it's already up is success, not failure),
//   3. otherwise picks the next free port, announces the URL, and launches.
// So the command always ends with a usable dashboard or a clear message —
// never an EADDRINUSE stack trace.
import { spawn } from "node:child_process";
import { get } from "node:http";
import { createServer } from "node:net";

const PREFERRED_PORT = Number.parseInt(process.env.PORT ?? "3200", 10);
const MAX_TRIES = 20;
const APP_MARKER = "Oxagen Benchmark Suite";

/** Resolve true if nothing is listening on `port`. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "0.0.0.0");
  });
}

/** Resolve true if the server on `port` is already this benchmark app. */
function isBenchApp(port) {
  return new Promise((resolve) => {
    const req = get({ host: "localhost", port, path: "/", timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 8192) req.destroy();
      });
      res.on("end", () => resolve(body.includes(APP_MARKER)));
    });
    req.once("error", () => resolve(false));
    req.once("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function pickPort() {
  for (let port = PREFERRED_PORT; port < PREFERRED_PORT + MAX_TRIES; port++) {
    if (await isPortFree(port)) return port;
  }
  return null;
}

async function main() {
  let port = PREFERRED_PORT;

  if (!(await isPortFree(PREFERRED_PORT))) {
    if (await isBenchApp(PREFERRED_PORT)) {
      console.log(
        `✓ Benchmark dashboard is already running at http://localhost:${PREFERRED_PORT}`,
      );
      console.log("  (nothing to do — open that URL, or run `pnpm kill` first to restart)");
      return;
    }
    const free = await pickPort();
    if (free === null) {
      console.error(
        `✗ Ports ${PREFERRED_PORT}-${PREFERRED_PORT + MAX_TRIES - 1} are all in use.`,
      );
      console.error("  Free one (e.g. `pnpm kill`) and retry, or set PORT=<n>.");
      process.exit(1);
    }
    port = free;
    console.log(
      `! Port ${PREFERRED_PORT} is busy — starting the benchmark dashboard on ${port} instead.`,
    );
    console.log(`  → http://localhost:${port}`);
  }

  const child = spawn("next", ["dev", "--port", String(port)], {
    stdio: "inherit",
    env: process.env,
  });

  const forward = (signal) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
