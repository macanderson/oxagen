#!/usr/bin/env node
/**
 * Development Server Launcher
 *
 * Resilient launcher that prefers port 3300 but finds an alternative if busy.
 */

import { spawn } from "child_process";
import { createServer } from "net";

const PREFERRED_PORT = 3300;

async function findAvailablePort(preferred) {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", () => {
      // Port is in use, try next
      resolve(findAvailablePort(preferred + 1));
    });

    server.once("listening", () => {
      server.close();
      resolve(preferred);
    });

    server.listen(preferred, "localhost");
  });
}

async function main() {
  const port = await findAvailablePort(PREFERRED_PORT);

  console.log(`🚀 Starting Arena dev server on port ${port}`);
  console.log(`   Dashboard: http://localhost:${port}`);
  console.log();

  // Use npx to run next from local node_modules
  const next = spawn("npx", ["next", "dev", "-p", String(port)], {
    stdio: "inherit",
    env: { ...process.env, PORT: String(port) },
    cwd: process.cwd()
  });

  next.on("error", (error) => {
    console.error("Failed to start dev server:", error);
    process.exit(1);
  });

  process.on("SIGINT", () => {
    console.log("\n👋 Shutting down dev server...");
    next.kill("SIGINT");
  });
}

main();
