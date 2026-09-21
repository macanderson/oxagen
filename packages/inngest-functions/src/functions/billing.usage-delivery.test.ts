import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ deliver: vi.fn(), create: vi.fn() }));
vi.mock("@oxagen/billing", () => ({ deliverUsageOutbox: mocks.deliver }));
vi.mock("../create-function", () => ({
  createFunction: mocks.create.mockImplementation(
    (_config, _trigger, handler) => [handler],
  ),
}));
vi.mock("../logger", () => ({ logger: { info: vi.fn() } }));
await import("./billing.usage-delivery");
it("registers a minute delivery sweep and preserves the retry result", async () => {
  const [config, trigger, handler] = mocks.create.mock.calls[0]!;
  expect(config).toMatchObject({ id: "billing.usage-delivery", retries: 3 });
  expect(trigger).toEqual({ cron: "* * * * *" });
  mocks.deliver
    .mockReset()
    .mockResolvedValue({ selected: 3, delivered: 2, failed: 1, incomplete: 3 });
  const step = { run: vi.fn(async (_name, fn) => fn()) };
  await expect(handler({ step })).resolves.toEqual({
    delivered: 2,
    failed: 1,
    incomplete: 3,
  });
  expect(step.run).toHaveBeenCalledWith(
    "deliver-usage-0",
    expect.any(Function),
  );
});

it("drains more than 100 rows with one frozen boundary and serialized sweeps", async () => {
  const [config, , handler] = mocks.create.mock.calls[0]!;
  expect(config.concurrency).toEqual({ limit: 1 });
  mocks.deliver
    .mockReset()
    .mockResolvedValueOnce({
      selected: 100,
      delivered: 80,
      failed: 20,
      incomplete: 0,
    })
    .mockResolvedValueOnce({
      selected: 100,
      delivered: 100,
      failed: 0,
      incomplete: 0,
    })
    .mockResolvedValueOnce({
      selected: 1,
      delivered: 1,
      failed: 0,
      incomplete: 2,
    });
  const step = { run: vi.fn(async (_name, fn) => fn()) };
  await expect(handler({ step })).resolves.toEqual({
    delivered: 181,
    failed: 20,
    incomplete: 2,
  });
  expect(mocks.deliver).toHaveBeenCalledTimes(3);
  expect(
    new Set(
      mocks.deliver.mock.calls.map(([, boundary]) => boundary.toISOString()),
    ).size,
  ).toBe(1);
  expect(step.run.mock.calls.map(([name]) => name)).toEqual([
    "delivery-boundary",
    "deliver-usage-0",
    "deliver-usage-1",
    "deliver-usage-2",
  ]);
});
