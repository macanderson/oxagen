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
import { captureWriter, type CommandWriter } from "../../lib/capture-writer.js";

/**
 * A CommandWriter that keeps stdout and stderr in SEPARATE buffers so the
 * ADR-023 §4 discipline is provable — `status` data lands on stdout, `on`/`off`
 * confirmations and errors land on stderr. The plain captureWriter merges the
 * two, which cannot distinguish the streams.
 */
function splitWriter(): {
  writer: CommandWriter;
  out: () => string;
  err: () => string;
} {
  const o: string[] = [];
  const e: string[] = [];
  return {
    writer: {
      write: (l) => {
        o.push(l);
      },
      writeErr: (l) => {
        e.push(l);
      },
    },
    out: () => o.join("\n"),
    err: () => e.join("\n"),
  };
}

vi.mock("../../lib/config.js", () => ({
  getApiUrl: vi.fn(() => "https://api.oxagen.sh"),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

import { readConfig, writeConfig } from "../../lib/config.js";
import {
  telemetryStatus,
  telemetryOn,
  telemetryOff,
  handleTelemetry,
} from "../telemetry.js";

const mockReadConfig = readConfig as ReturnType<typeof vi.fn>;
const mockWriteConfig = writeConfig as ReturnType<typeof vi.fn>;

function setConfigReturn(config: CliConfig): void {
  mockReadConfig.mockReturnValue(config);
}

let writer: ReturnType<typeof captureWriter>["writer"];
let logged: () => string;

beforeEach(() => {
  vi.clearAllMocks();
  // isTelemetryEnabled() checks these directly (usage.ts) before falling back
  // to the mocked config — a dev machine or CI runner with DO_NOT_TRACK=1 set
  // ambiently (a common convention) would otherwise make "enabled by default"
  // fail non-deterministically depending on where the suite runs.
  delete process.env["DO_NOT_TRACK"];
  delete process.env["OXAGEN_TELEMETRY"];
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
    setConfigReturn({
      telemetry: { installId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    });
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
      expect.objectContaining({
        telemetry: expect.objectContaining({ enabled: false }),
      }),
    );
  });

  it("telemetryOn persists telemetry.enabled=true", () => {
    setConfigReturn({ telemetry: { enabled: false } });
    telemetryOn(writer);
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: expect.objectContaining({ enabled: true }),
      }),
    );
  });

  it("preserves the existing installId/disclosed fields when toggling", () => {
    setConfigReturn({
      telemetry: { installId: "id-1", disclosed: true, enabled: false },
    });
    telemetryOn(writer);
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: expect.objectContaining({
          installId: "id-1",
          disclosed: true,
          enabled: true,
        }),
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
      expect.objectContaining({
        telemetry: expect.objectContaining({ enabled: false }),
      }),
    );

    vi.clearAllMocks();
    setConfigReturn({});
    handleTelemetry("on", writer);
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: expect.objectContaining({ enabled: true }),
      }),
    );

    vi.clearAllMocks();
    setConfigReturn({});
    handleTelemetry("status", writer);
    expect(logged()).toContain("Telemetry:");
  });

  it("rejects an unknown subcommand with a usage exit code (2)", () => {
    handleTelemetry("bogus", writer);
    expect(logged()).toContain("Unknown telemetry subcommand");
    // ADR-023 §4: a bad subcommand is a usage error → exit 2 (not a runtime 1).
    expect(process.exitCode).toBe(2);
  });
});

// The ADR-023 §4 contract for telemetry (which has no --json flag today):
// `status` is a data payload on stdout; `on`/`off` are side-effects whose
// confirmation goes to stderr; an unknown subcommand is a uniform stderr error
// line with a usage (2) exit code.
describe("telemetry output discipline (ADR-023 §4)", () => {
  it("status writes its report to stdout and nothing to stderr", () => {
    setConfigReturn({});
    const sp = splitWriter();
    telemetryStatus(sp.writer);
    expect(sp.out()).toContain("Telemetry: enabled");
    expect(sp.out()).toContain("https://api.oxagen.sh/v1/telemetry/usage");
    expect(sp.err()).toBe("");
  });

  it("on routes its confirmation to stderr, keeping stdout clean", () => {
    setConfigReturn({});
    const sp = splitWriter();
    telemetryOn(sp.writer);
    expect(sp.out()).toBe("");
    expect(sp.err()).toContain("✓ Telemetry enabled.");
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: expect.objectContaining({ enabled: true }),
      }),
    );
  });

  it("off routes its confirmation to stderr, keeping stdout clean", () => {
    setConfigReturn({});
    const sp = splitWriter();
    telemetryOff(sp.writer);
    expect(sp.out()).toBe("");
    expect(sp.err()).toContain("no usage data will be sent");
  });

  it("an unknown subcommand is a uniform stderr error line with nothing on stdout", () => {
    const sp = splitWriter();
    handleTelemetry("bogus", sp.writer);
    expect(sp.out()).toBe("");
    expect(sp.err()).toContain("Unknown telemetry subcommand");
    expect(process.exitCode).toBe(2);
  });
});
