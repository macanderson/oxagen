// log.test.ts: jsonLog, which writes one JSON line per event, and logPath, which drops a path's query.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonLog, logPath, type RelayLog } from "./log";
import { NOW, RELAY } from "./test/fixtures";

const AT = "2026-09-28T12:00:00.000Z";

/** A log that keeps each written line. */
function recordingLog(): { lines: string[]; log: RelayLog } {
  const lines: string[] = [];
  return { lines, log: jsonLog((line) => lines.push(line)) };
}

describe("jsonLog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes one JSON line with the time and the event first, then the fields", () => {
    const { lines, log } = recordingLog();

    log("relay.connected", { relay: RELAY, attempt: 2, tls: true });

    expect(lines).toEqual([`{"at":"${AT}","event":"relay.connected","relay":"office","attempt":2,"tls":true}\n`]);
  });

  it("writes only the time and the event when there are no fields", () => {
    const { lines, log } = recordingLog();

    log("relay.started");

    expect(lines).toEqual([`{"at":"${AT}","event":"relay.started"}\n`]);
  });

  it("leaves out a field whose value is undefined", () => {
    const { lines, log } = recordingLog();

    log("call.done", { id: "call-1", status: undefined });

    expect(lines).toEqual([`{"at":"${AT}","event":"call.done","id":"call-1"}\n`]);
  });

  it("keeps a value that holds a line break on one line", () => {
    const { lines, log } = recordingLog();

    log("call.failed", { message: "line one\nline two" });

    const [line = ""] = lines;
    // The only raw line break is the one that ends the line.
    expect(line.match(/\n/g)).toEqual(["\n"]);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ at: AT, event: "call.failed", message: "line one\nline two" });
  });

  it("reads the clock for each line", () => {
    const { lines, log } = recordingLog();

    log("relay.heartbeat");
    vi.setSystemTime(NOW + 1500);
    log("relay.heartbeat");

    expect(lines.map((line) => (JSON.parse(line) as { at: string }).at)).toEqual([AT, "2026-09-28T12:00:01.500Z"]);
  });

  it("keeps the time and the event when a field uses either name", () => {
    const { lines, log } = recordingLog();

    log("relay.connected", { at: "earlier", event: "something.else", relay: RELAY });

    expect(lines).toEqual([`{"at":"${AT}","event":"relay.connected","relay":"office"}\n`]);
  });

  it("writes to standard output when given no writer", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      jsonLog()("relay.started", { relay: RELAY });

      expect(write).toHaveBeenCalledWith(`{"at":"${AT}","event":"relay.started","relay":"office"}\n`);
    } finally {
      write.mockRestore();
    }
  });
});

describe("logPath", () => {
  it("drops the query string, which may hold a secret", () => {
    expect(logPath("/v1/invoices?limit=5&token=s3cret")).toBe("/v1/invoices");
  });

  it("leaves a path with no query unchanged", () => {
    expect(logPath("/v1/invoices")).toBe("/v1/invoices");
    expect(logPath("/")).toBe("/");
  });

  it("cuts at the first question mark", () => {
    expect(logPath("/a?b?c")).toBe("/a");
  });

  it("returns an empty string for a path that is only a query", () => {
    expect(logPath("?token=s3cret")).toBe("");
  });

  it("keeps a trailing question mark out of the result", () => {
    expect(logPath("/v1/invoices?")).toBe("/v1/invoices");
  });
});
