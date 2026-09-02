import { hostname } from "node:os";
import { insertDevLogs, type DevLogRow } from "@oxagen/telemetry";

// Batch-ships `pnpm dev` console lines into the local ClickHouse `dev_logs`
// table. Fire-and-forget by contract: a ClickHouse hiccup must never break the
// dev stack, so every insert failure is swallowed (warned once) and dev keeps
// running. See tools/scripts/dev.ts for the turbo stream tap that feeds this.

// Match SGR color escapes so the stored message is plain text while the teed
// terminal output keeps its colors. Built from the ESC char code rather than a
// literal control char to avoid a no-control-regex lint warning.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// Flush cadence: small enough that a crash's last lines land before exit, large
// enough to coalesce the boot-time compile spam into few round-trips.
const FLUSH_EVERY_MS = 750;
const MAX_BATCH = 500;
// Cap a single line so a stray megabyte-long stack/dump can't bloat one row.
const MAX_MESSAGE_LEN = 8000;

/** Strip the turbo `<package>:<task>:` prefix so `service` is the workspace name. */
function parseLine(raw: string): { service: string; message: string } {
  const clean = raw.replace(ANSI, "");
  const m = clean.match(/^([^\s:]+):([^\s:]+):\s?(.*)$/);
  if (m) return { service: m[1] ?? "turbo", message: m[3] ?? clean };
  return { service: "turbo", message: clean };
}

/** Best-effort log level from line content — no structured level on raw turbo output. */
function detectLevel(message: string): DevLogRow["level"] {
  const m = message.toLowerCase();
  if (
    /(?:^|[^a-z])(error|fatal|econnrefused|eaddrinuse|unhandled|uncaught|exception|failed)(?:[^a-z]|$)/.test(
      m,
    )
  ) {
    return "error";
  }
  if (/(?:^|[^a-z])(warn|deprecat)(?:[^a-z]|$)/.test(m)) return "warn";
  return "info";
}

export interface DevLogShipper {
  /** Enqueue one console line (already split on newline, `\r` trimmed). */
  push(stream: "stdout" | "stderr", rawLine: string): void;
  /** Flush any buffered rows now. */
  flush(): Promise<void>;
  /** Stop the timer and flush the final batch. */
  close(): Promise<void>;
}

export function createDevLogShipper(devSession: string): DevLogShipper {
  const host = hostname();
  let buffer: DevLogRow[] = [];
  let warned = false;

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    try {
      await insertDevLogs(batch);
    } catch (err) {
      if (!warned) {
        warned = true;
        process.stderr.write(
          `[dev] ClickHouse dev-log capture failed (dev stack unaffected): ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  }

  const timer = setInterval(() => void flush(), FLUSH_EVERY_MS);
  // Don't let the flush timer keep the process alive after turbo exits.
  timer.unref();

  return {
    push(stream, rawLine) {
      if (rawLine.length === 0) return;
      const { service, message } = parseLine(rawLine);
      if (message.length === 0) return;
      buffer.push({
        dev_session: devSession,
        service,
        stream,
        level: detectLevel(message),
        message:
          message.length > MAX_MESSAGE_LEN
            ? message.slice(0, MAX_MESSAGE_LEN)
            : message,
        ts: new Date().toISOString(),
        host,
      });
      if (buffer.length >= MAX_BATCH) void flush();
    },
    flush,
    async close() {
      clearInterval(timer);
      await flush();
    },
  };
}
