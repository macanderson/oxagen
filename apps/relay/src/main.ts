// main.ts: the relay's entry point in the container.
//
// It reads the settings from the environment, exits 2 with every problem
// listed when they do not check, and otherwise holds the connection to the
// broker until SIGTERM or SIGINT.
import { loadRelayConfig, RelayConfigError, type RelayConfig } from "./config";
import { startRelay } from "./connection";
import { jsonLog } from "./log";

// build.mjs replaces this with the version in package.json.
declare const __RELAY_VERSION__: string;

function readConfig(): RelayConfig {
  try {
    return loadRelayConfig(process.env);
  } catch (error) {
    if (error instanceof RelayConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
}

function main(): void {
  const config = readConfig();
  const log = jsonLog();
  const relay = startRelay({ config, version: __RELAY_VERSION__, log });
  const shutdown = (signal: string): void => {
    log("signal", { signal });
    void relay.stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main();
