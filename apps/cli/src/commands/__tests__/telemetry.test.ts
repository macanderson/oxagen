/**
 * telemetry command unit tests — `oxagen telemetry on|off|status`.
 *
 * Mocks: config reads/writes (../../lib/config.js). No filesystem writes.
 * Output is captured through the `CommandWriter` seam every handler now takes
 * as an optional trailing argument (see lib/capture-writer.ts — the REPL's
 * inline capture-execution seam, PR C item 11) rather than spying on
 * `console.log`/`console.error`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import type { CliConfig } from "../../lib/config.js";
import { captureWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/config.js", () => ({
  getApiUrl: vi.fn(() => "https://api.oxagen.sh"),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

import { readConfig, writeConfig } from "../../lib/config.js";
import { telemetryStatus, telemetryOn, telemetryOff, handleTelemetry } from "../telemetry.js";

const mockReadConfig = readConfig as ReturnType<typeof vi.fn>;
const mockWriteConfig = writeConfig as ReturnType<typeof vi.fn>;

function setConfigReturn(config: CliConfig): void {
  mockReadConfig.mockReturnValue(config);
}

let writer: ReturnType<typeof captureWriter>["writer"];
let logged: () => string;

beforeEach(() => {
  vi.clearAllMocks();
  setConfigReturn({});
  const cap = captureWriter();
  writer = cap.writer;
  logged = cap.output;
  process.exitCode = undefined;
});

describe("telemetryStatus", () => {
  it("reports enabled by default and the ingest endpoint", () => {
    setConfigReturn({});
    telemetryStatus(writer);
    expect(logged()).toContain("Telemetry: enabled");
    expect(logged()).toContain("https://api.oxagen.sh/v1/telemetry/usage");
  });

  it("reports disabled when telemetry.enabled=false", () => {
    setConfigReturn({ telemetry: { enabled: false } });
    telemetryStatus(writer);
    expect(logged()).toContain("Telemetry: disabled");
  });

  it("shows the persisted install id when one exists", () => {
    setConfigReturn({ telemetry: { installId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } });
    telemetryStatus(writer);
    expect(logged()).toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("never generates an id as a side effect (status is read-only)", () => {
    setConfigReturn({});
    telemetryStatus(writer);
    expect(mockWriteConfig).not.toHaveBeenCalled();
    expect(logged()).toContain("not yet generated");
  });
});

describe("telemetryOn / telemetryOff", () => {
  it("telemetryOff persists telemetry.enabled=false", () => {
    setConfigReturn({});
    telemetryOff(writer);
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ telemetry: expect.objectContaining({ enabled: false }) }),
    );
  });

  it("telemetryOn persists telemetry.enabled=true", () => {
    setConfigReturn({ telemetry: { enabled: false } });
    telemetryOn(writer);
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ telemetry: expect.objectContaining({ enabled: true }) }),
    );
  });

  it("preserves the existing installId/disclosed fields when toggling", () => {
    setConfigReturn({ telemetry: { installId: "id-1", disclosed: true, enabled: false } });
    telemetryOn(writer);
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: expect.objectContaining({ installId: "id-1", disclosed: true, enabled: true }),
      }),
    );
  });
});

describe("handleTelemetry — subcommand dispatch", () => {
  it("defaults to status with no argument", () => {
    handleTelemetry(undefined, writer);
    expect(logged()).toContain("Telemetry:");
  });

  it("dispatches on/off/status by name", () => {
    handleTelemetry("off", writer);
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ telemetry: expect.objectContaining({ enabled: false }) }),
    );

    vi.clearAllMocks();
    setConfigReturn({});
    handleTelemetry("on", writer);
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ telemetry: expect.objectContaining({ enabled: true }) }),
    );

    vi.clearAllMocks();
    setConfigReturn({});
    handleTelemetry("status", writer);
    expect(logged()).toContain("Telemetry:");
  });

  it("rejects an unknown subcommand with a non-zero exit code", () => {
    handleTelemetry("bogus", writer);
    expect(logged()).toContain("Unknown telemetry subcommand");
    expect(process.exitCode).toBe(1);
  });
});
