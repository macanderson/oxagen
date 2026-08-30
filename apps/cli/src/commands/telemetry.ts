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
 *
 * Output discipline (ADR-023 §4): `status` is a data payload emitted via
 * `out.data` (the human view goes to stdout); `on`/`off` are pure side-effects
 * whose confirmation goes to stderr via `out.info`; an unknown subcommand is a
 * uniform stderr usage error with exit code 2. There is NO `--json` flag today:
 * these handlers take only `(subcommand?, writer)` — the REPL-bridge shape, with
 * no options object to carry `json` — and program.tsx declares none. `status`
 * is nonetheless routed through `out.data` so it is single-line-JSON-ready the
 * moment a flag can be threaded (which needs both a program.tsx `--json` option
 * and a signature able to carry it without breaking the bridge).
 */
import { readConfig, writeConfig, getApiUrl } from "../lib/config.js";
import { isTelemetryEnabled } from "../telemetry/usage.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

interface TelemetryStatusData {
  enabled: boolean;
  installId: string | null;
  ingestEndpoint: string;
}

export function telemetryStatus(writer: CommandWriter = stdoutWriter): void {
  const out = createOutput({}, writer);
  const enabled = isTelemetryEnabled();
  const config = readConfig();
  const installId = config.telemetry?.installId ?? null;
  const ingestEndpoint = `${getApiUrl()}/v1/telemetry/usage`;
  const status: TelemetryStatusData = { enabled, installId, ingestEndpoint };
  out.data(status, () =>
    [
      `Telemetry: ${enabled ? "enabled" : "disabled"}`,
      `Install id: ${installId ?? "(not yet generated — created on first command)"}`,
      `Ingest endpoint: ${ingestEndpoint}`,
      "See TELEMETRY.md for the full disclosure.",
    ].join("\n"),
  );
}

export function telemetryOn(writer: CommandWriter = stdoutWriter): void {
  const config = readConfig();
  writeConfig({ telemetry: { ...config.telemetry, enabled: true } });
  createOutput({}, writer).info("✓ Telemetry enabled.");
}

export function telemetryOff(writer: CommandWriter = stdoutWriter): void {
  const config = readConfig();
  writeConfig({ telemetry: { ...config.telemetry, enabled: false } });
  createOutput({}, writer).info(
    "✓ Telemetry disabled — no usage data will be sent.",
  );
}

const SUBCOMMANDS = ["on", "off", "status"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

/** `oxagen telemetry [on|off|status]` — defaults to `status` with no argument. */
export function handleTelemetry(
  subcommand?: string,
  writer: CommandWriter = stdoutWriter,
): void {
  const cmd = subcommand ?? "status";
  if (!isSubcommand(cmd)) {
    process.exitCode = 2;
    createOutput({}, writer).error(
      `Unknown telemetry subcommand "${cmd}". Use one of: ${SUBCOMMANDS.join(", ")}`,
      "usage",
    );
    return;
  }
  switch (cmd) {
    case "on":
      telemetryOn(writer);
      return;
    case "off":
      telemetryOff(writer);
      return;
    case "status":
      telemetryStatus(writer);
  }
}
