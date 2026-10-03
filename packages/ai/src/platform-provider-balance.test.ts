// The alert for Oxagen's own provider balance running out (#5408): once an
// hour across every process, and never silent when the counter cannot be read.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/database", () => ({
  schema: { rateLimitCounters: {} },
  withSystemDb: vi.fn(),
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));

import {
  isPlatformProviderBalanceError,
  PLATFORM_PROVIDER_BALANCE_ALERT_WINDOW_MS,
  PlatformProviderBalanceError,
  reportPlatformProviderBalance,
  resetPlatformBalanceAlertForTests,
} from "./platform-provider-balance";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const refusal = { orgId: ORG, statusCode: 402, vendorMessage: "Insufficient credits" };
const HOUR = PLATFORM_PROVIDER_BALANCE_ALERT_WINDOW_MS;
const at = (ms: number) => new Date(Date.UTC(2026, 9, 3, 12) + ms);

function deps(first: () => Promise<boolean>) {
  return { firstInWindow: vi.fn(first), capture: vi.fn() };
}

beforeEach(() => {
  resetPlatformBalanceAlertForTests();
});

describe("reportPlatformProviderBalance", () => {
  it("alerts on the first refusal of the hour and asks the counter about the hour it falls in", async () => {
    const d = deps(async () => true);
    await reportPlatformProviderBalance(refusal, at(5 * 60 * 1000), d);
    expect(d.firstInWindow).toHaveBeenCalledWith(at(0));
    expect(d.capture).toHaveBeenCalledTimes(1);
    expect(d.capture.mock.calls[0]?.[0]).toMatchObject({ orgId: ORG, severity: "error" });
    expect(isPlatformProviderBalanceError(d.capture.mock.calls[0]?.[0]?.error)).toBe(true);
  });

  it("does not alert when another process already alerted this hour", async () => {
    const d = deps(async () => false);
    await reportPlatformProviderBalance(refusal, at(0), d);
    expect(d.capture).not.toHaveBeenCalled();
  });

  it("alerts again in the next hour while the refusals continue", async () => {
    const d = deps(async () => true);
    await reportPlatformProviderBalance(refusal, at(0), d);
    await reportPlatformProviderBalance(refusal, at(30 * 60 * 1000), d);
    await reportPlatformProviderBalance(refusal, at(HOUR + 1), d);
    expect(d.firstInWindow).toHaveBeenCalledTimes(2);
    expect(d.capture).toHaveBeenCalledTimes(2);
  });

  it("alerts when the counter cannot be read, rather than staying silent", async () => {
    const d = deps(async () => {
      throw new Error("pg down");
    });
    await expect(reportPlatformProviderBalance(refusal, at(0), d)).resolves.toBeUndefined();
    expect(d.capture).toHaveBeenCalledTimes(1);
  });
});

describe("isPlatformProviderBalanceError", () => {
  it("matches the error by its code, and nothing else", () => {
    expect(isPlatformProviderBalanceError(new PlatformProviderBalanceError())).toBe(true);
    expect(isPlatformProviderBalanceError({ code: "platform_provider_balance" })).toBe(true);
    expect(isPlatformProviderBalanceError(new Error("Insufficient credits"))).toBe(false);
    expect(isPlatformProviderBalanceError({ code: "assistant_model_key_limit" })).toBe(false);
    expect(isPlatformProviderBalanceError(null)).toBe(false);
  });
});
