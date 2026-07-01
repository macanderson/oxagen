import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Warning } from "ai";
import { installAiSdkWarningFilter } from "../ai-warnings.js";

type Logger = (opts: {
  warnings: Warning[];
  provider: string;
  model: string;
}) => void;

const RESPONSE_FORMAT_WARNING: Warning = {
  type: "unsupported",
  feature: "responseFormat",
  details:
    "JSON response format schema is only supported with structuredOutputs",
};

function currentLogger(): Logger {
  const logger = (globalThis as { AI_SDK_LOG_WARNINGS?: unknown })
    .AI_SDK_LOG_WARNINGS;
  if (typeof logger !== "function") throw new Error("logger not installed");
  return logger as Logger;
}

describe("installAiSdkWarningFilter", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const original = (globalThis as { AI_SDK_LOG_WARNINGS?: unknown })
    .AI_SDK_LOG_WARNINGS;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    installAiSdkWarningFilter();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    (globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS =
      original;
  });

  it("installs a function logger on the AI SDK global", () => {
    expect(typeof currentLogger()).toBe("function");
  });

  it("swallows the responseFormat unsupported warning", () => {
    currentLogger()({
      warnings: [RESPONSE_FORMAT_WARNING],
      provider: "oxagen-platform",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still surfaces other unsupported warnings with the default format", () => {
    currentLogger()({
      warnings: [{ type: "unsupported", feature: "temperature" }],
      provider: "oxagen-platform",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toBe(
      'AI SDK Warning (oxagen-platform / anthropic/claude-haiku-4-5): The feature "temperature" is not supported.',
    );
  });

  it("surfaces 'other' warnings and drops only the benign one in a mixed batch", () => {
    currentLogger()({
      warnings: [
        RESPONSE_FORMAT_WARNING,
        { type: "other", message: "something odd" },
      ],
      provider: "oxagen-platform",
      model: "m",
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toBe(
      "AI SDK Warning (oxagen-platform / m): something odd",
    );
  });
});
