import { describe, expect, it, vi, beforeEach } from "vitest";
import type {
  SandboxResult,
  SandboxDriver,
  SandboxRequest,
} from "@oxagen/sandbox";

const SENTINEL = "<<<OXAGEN_FMT_RESULT>>>";

let nextStdout = "";
const mockRun = vi.fn(
  async (_req: SandboxRequest): Promise<SandboxResult> => ({
    exitCode: 0,
    stdout: nextStdout,
    stderr: "",
    durationMs: 12,
    timedOut: false,
    oomKilled: false,
  }),
);

const mockDriver: SandboxDriver = {
  name: "mock",
  run: mockRun,
  async *stream() {},
};

vi.mock("@oxagen/sandbox", () => ({
  isSandboxAvailable: vi.fn(() => true),
  getSandbox: vi.fn((): SandboxDriver => mockDriver),
}));

const { mockInsertEvents } = vi.hoisted(() => ({
  mockInsertEvents: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("@oxagen/telemetry", () => ({ insertEvents: mockInsertEvents }));

import { codeFormatHandler } from "./code.format";
import { isSandboxAvailable, getSandbox } from "@oxagen/sandbox";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

function driverLine(payload: Record<string, unknown>): string {
  return `noise from runtime\n${SENTINEL}${JSON.stringify(payload)}\n`;
}

describe("code.format handler", () => {
  beforeEach(() => {
    mockRun.mockClear();
    mockInsertEvents.mockClear();
    mockInsertEvents.mockResolvedValue(undefined);
    vi.mocked(isSandboxAvailable).mockReturnValue(true);
    vi.mocked(getSandbox).mockReturnValue(mockDriver);
    nextStdout = "";
  });

  it("formats json and reports changed=true", async () => {
    const formatted = '{\n  "a": 1\n}';
    nextStdout = driverLine({ ok: true, formatted });
    const result = await codeFormatHandler(
      { language: "json", source: '{"a":1}', indent: 2 },
      CTX,
    );
    expect(result).toEqual({ formatted, changed: true, language: "json" });
  });

  it("builds a python driver embedding the base64 source and the json formatter", async () => {
    nextStdout = driverLine({ ok: true, formatted: "{}" });
    await codeFormatHandler(
      { language: "json", source: '{"a":1}', indent: 4 },
      CTX,
    );
    const call = mockRun.mock.calls[0]![0];
    expect(call.language).toBe("python");
    expect(call.network).toBe("deny");
    expect(call.code).toContain("json.dumps");
    expect(call.code).toContain("indent=4");
    expect(call.code).toContain(
      Buffer.from('{"a":1}', "utf-8").toString("base64"),
    );
  });

  it("formats python via the ast round-trip driver", async () => {
    nextStdout = driverLine({ ok: true, formatted: "x = 1" });
    const result = await codeFormatHandler(
      { language: "python", source: "x=1", indent: 2 },
      CTX,
    );
    expect(result.formatted).toBe("x = 1");
    expect(result.language).toBe("python");
    const call = mockRun.mock.calls[0]![0];
    expect(call.code).toContain("ast.unparse");
  });

  it("reports changed=false when the formatter is a no-op", async () => {
    nextStdout = driverLine({ ok: true, formatted: "x = 1" });
    const result = await codeFormatHandler(
      { language: "python", source: "x = 1", indent: 2 },
      CTX,
    );
    expect(result.changed).toBe(false);
  });

  it("throws when the sandbox is unavailable", async () => {
    vi.mocked(isSandboxAvailable).mockReturnValue(false);
    await expect(
      codeFormatHandler({ language: "json", source: "{}", indent: 2 }, CTX),
    ).rejects.toThrow(/not available/);
  });

  it("surfaces a formatter syntax error from the driver", async () => {
    nextStdout = driverLine({ ok: false, error: "SyntaxError: invalid" });
    await expect(
      codeFormatHandler(
        { language: "python", source: "def (", indent: 2 },
        CTX,
      ),
    ).rejects.toThrow(/SyntaxError/);
  });

  it("throws when no sentinel result is produced", async () => {
    nextStdout = "totally unrelated output";
    await expect(
      codeFormatHandler({ language: "json", source: "{}", indent: 2 }, CTX),
    ).rejects.toThrow(/no result/);
  });

  it("throws when the formatter run times out", async () => {
    mockRun.mockResolvedValueOnce({
      exitCode: 137,
      stdout: "",
      stderr: "",
      durationMs: 30_001,
      timedOut: true,
      oomKilled: false,
    });
    await expect(
      codeFormatHandler({ language: "json", source: "{}", indent: 2 }, CTX),
    ).rejects.toThrow(/timed out/);
  });

  it("meters the run to ClickHouse with the language and duration", async () => {
    nextStdout = driverLine({ ok: true, formatted: "{}" });
    await codeFormatHandler({ language: "json", source: "{}", indent: 2 }, CTX);
    expect(mockInsertEvents).toHaveBeenCalledTimes(1);
    const rows = mockInsertEvents.mock.calls[0]![0] as Array<
      Record<string, unknown>
    >;
    const row = rows[0]!;
    expect(row.event_type).toBe("code.format.ran");
    const payload = JSON.parse(row.payload as string) as Record<
      string,
      unknown
    >;
    expect(payload.language).toBe("json");
    expect(payload.capability).toBe("format_code");
  });

  it("never fails the run when telemetry throws", async () => {
    mockInsertEvents.mockRejectedValueOnce(new Error("clickhouse down"));
    nextStdout = driverLine({ ok: true, formatted: "{}" });
    const result = await codeFormatHandler(
      { language: "json", source: "{}", indent: 2 },
      CTX,
    );
    expect(result.formatted).toBe("{}");
  });
});
