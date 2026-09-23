import { afterEach, describe, expect, it, vi } from "vitest";
const { select } = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@oxagen/telemetry", () => ({ selectSteeringDeliveries: select }));
import { contextSteeringDeliveries } from "@oxagen/oxagen/contracts/context.steering.deliveries";
import { getSteeringDeliveriesHandler } from "./context.steering.deliveries";
import { TEST_CTX } from "./test-utils/fixtures";
afterEach(() => {
  vi.useRealTimers();
  select.mockReset();
});
describe("get_steering_deliveries", () => {
  it("reads a seven-day window with bounded defaults", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
    const result = { runs: [], undelivered: [], scanned: 0, truncated: false };
    select.mockResolvedValue(result);
    expect(
      await getSteeringDeliveriesHandler(
        contextSteeringDeliveries.input.parse({}),
        TEST_CTX,
      ),
    ).toEqual(result);
    expect(select).toHaveBeenCalledWith({
      fromMs: Date.parse("2026-09-15T00:00:00Z"),
      toMs: Date.now(),
      limit: 50,
    });
    expect(contextSteeringDeliveries.output.parse(result)).toEqual(result);
  });
  it("rejects unbounded windows and page sizes", () => {
    for (const input of [
      { days: 0 },
      { days: 31 },
      { limit: 0 },
      { limit: 101 },
      { days: 1.5 },
    ]) {
      expect(contextSteeringDeliveries.input.safeParse(input).success).toBe(
        false,
      );
    }
  });
  it("propagates a telemetry failure", async () => {
    select.mockRejectedValue(new Error("unavailable"));
    await expect(
      getSteeringDeliveriesHandler({ days: 1, limit: 1 }, TEST_CTX),
    ).rejects.toThrow("unavailable");
  });
});
