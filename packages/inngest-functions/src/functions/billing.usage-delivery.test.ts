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
  mocks.deliver.mockResolvedValue({ delivered: 2, failed: 1, incomplete: 3 });
  const step = { run: vi.fn(async (_name, fn) => fn()) };
  await expect(handler({ step })).resolves.toEqual({
    delivered: 2,
    failed: 1,
    incomplete: 3,
  });
  expect(step.run).toHaveBeenCalledWith("deliver-usage", expect.any(Function));
});
