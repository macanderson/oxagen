/**
 * telemetry command unit tests — `oxagen telemetry on|off|status`.
 *
 * Mocks: config reads/writes (../../lib/config.js). No filesystem writes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CliConfig } from "../../lib/config.js";

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

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  setConfigReturn({});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  process.exitCode = undefined;
});

function logged(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

describe("telemetryStatus", () => {
  it("reports enabled by default and the ingest endpoint", () => {
    setConfigReturn({});
    telemetryStatus();
    expect(logged()).toContain("Telemetry: enabled");
    expect(logged()).toContain("https://api.oxagen.sh/v1/telemetry/usage");
  });

  it("reports disabled when telemetry.enabled=false", () => {
    setConfigReturn({ telemetry: { enabled: false } });
    telemetryStatus();
    expect(logged()).toContain("Telemetry: disabled");
  });

  it("shows the persisted install id when one exists", () => {
    setConfigReturn({ telemetry: { installId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } });
    telemetryStatus();
    expect(logged()).toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("never generates an id as a side effect (status is read-only)", () => {
    setConfigReturn({});
    telemetryStatus();
    expect(mockWriteConfig).not.toHaveBeenCalled();
    expect(logged()).toContain("not yet generated");
  });
});

describe("telemetryOn / telemetryOff", () => {
  it("telemetryOff persists telemetry.enabled=false", () => {
    setConfigReturn({});
    telemetryOff();
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ telemetry: expect.objectContaining({ enabled: false }) }),
    );
  });

  it("telemetryOn persists telemetry.enabled=true", () => {
    setConfigReturn({ telemetry: { enabled: false } });
    telemetryOn();
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ telemetry: expect.objectContaining({ enabled: true }) }),
    );
  });

  it("preserves the existing installId/disclosed fields when toggling", () => {
    setConfigReturn({ telemetry: { installId: "id-1", disclosed: true, enabled: false } });
    telemetryOn();
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: expect.objectContaining({ installId: "id-1", disclosed: true, enabled: true }),
      }),
    );
  });
});

describe("handleTelemetry — subcommand dispatch", () => {
  it("defaults to status with no argument", () => {
    handleTelemetry(undefined);
    expect(logged()).toContain("Telemetry:");
  });

  it("dispatches on/off/status by name", () => {
    handleTelemetry("off");
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ telemetry: expect.objectContaining({ enabled: false }) }),
    );

    vi.clearAllMocks();
    setConfigReturn({});
    handleTelemetry("on");
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ telemetry: expect.objectContaining({ enabled: true }) }),
    );

    vi.clearAllMocks();
    setConfigReturn({});
    handleTelemetry("status");
    expect(logged()).toContain("Telemetry:");
  });

  it("rejects an unknown subcommand with a non-zero exit code", () => {
    handleTelemetry("bogus");
    expect(errorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
