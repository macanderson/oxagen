/**
 * telemetry command — inspect and control anonymous usage telemetry.
 *
 *   oxagen telemetry status   Show enabled/disabled, install id, ingest endpoint
 *   oxagen telemetry on       Re-enable telemetry
 *   oxagen telemetry off      Disable telemetry (no id generation, no network)
 *
 * Telemetry is ON by default (opt-out) — see TELEMETRY.md at the repo root
 * for the full disclosure. `status` is read-only: it never generates an
 * install id as a side effect, it only reports what (if anything) is
 * currently persisted in ~/.config/oxagen/config.json.
 */
import { readConfig, writeConfig, getApiUrl } from "../lib/config.js";
import { isTelemetryEnabled } from "../telemetry/usage.js";

export function telemetryStatus(): void {
  const enabled = isTelemetryEnabled();
  const config = readConfig();
  console.log(`Telemetry: ${enabled ? "enabled" : "disabled"}`);
  console.log(
    `Install id: ${config.telemetry?.installId ?? "(not yet generated — created on first command)"}`,
  );
  console.log(`Ingest endpoint: ${getApiUrl()}/v1/telemetry/usage`);
  console.log("See TELEMETRY.md for the full disclosure.");
}

export function telemetryOn(): void {
  const config = readConfig();
  writeConfig({ telemetry: { ...config.telemetry, enabled: true } });
  console.log("✓ Telemetry enabled.");
}

export function telemetryOff(): void {
  const config = readConfig();
  writeConfig({ telemetry: { ...config.telemetry, enabled: false } });
  console.log("✓ Telemetry disabled — no usage data will be sent.");
}

const SUBCOMMANDS = ["on", "off", "status"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

/** `oxagen telemetry [on|off|status]` — defaults to `status` with no argument. */
export function handleTelemetry(subcommand?: string): void {
  const cmd = subcommand ?? "status";
  if (!isSubcommand(cmd)) {
    console.error(`Unknown telemetry subcommand "${cmd}". Use one of: ${SUBCOMMANDS.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  switch (cmd) {
    case "on":
      telemetryOn();
      return;
    case "off":
      telemetryOff();
      return;
    case "status":
      telemetryStatus();
  }
}
