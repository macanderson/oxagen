import { beforeEach, describe, expect, it, vi } from "vitest";

// Renewal cron tests: the hourly cron finds active subscriptions nearing expiry,
// re-provisions each via the shared provisioner, and marks a subscription 'error'
// when re-provisioning cannot renew (skip/unsupported) or throws.

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  provisionWebhookSubscription: vi.fn(),
  // Holder for the handler passed to createFunction (populated at import time).
  handlerRef: {
    current: null as
      | null
      | ((ctx: {
          step: { run: (n: string, f: () => unknown) => unknown };
        }) => Promise<unknown>),
  },
}));

vi.mock("@oxagen/database", () => ({ withSystemDb: mocks.withSystemDb }));
vi.mock("../lib/provision-webhook", () => ({
  provisionWebhookSubscription: mocks.provisionWebhookSubscription,
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Capture the handler passed to createFunction so we can invoke it directly.
vi.mock("../create-function", () => ({
  createFunction: (
    _cfg: unknown,
    _trigger: unknown,
    handler: (ctx: {
      step: { run: (n: string, f: () => unknown) => unknown };
    }) => Promise<unknown>,
  ) => {
    mocks.handlerRef.current = handler;
    return [handler];
  },
}));

import "./ingestion.webhook-renew";

// A step.run that just executes the fn (no durability in unit tests).
const step = { run: (_name: string, fn: () => unknown) => fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

function mockExpiringRows(rows: unknown[]) {
  // First withSystemDb call = the find query; subsequent = markSubscriptionError.
  const execute = vi.fn().mockResolvedValue(rows);
  mocks.withSystemDb.mockImplementation(
    (cb: (t: { execute: typeof execute }) => unknown) => cb({ execute }),
  );
  return execute;
}

describe("ingestion-webhook-renew", () => {
  it("re-provisions each expiring subscription", async () => {
    mockExpiringRows([
      { id: "ws1", connection_id: "c1", org_id: "o1" },
      { id: "ws2", connection_id: "c2", org_id: "o1" },
    ]);
    mocks.provisionWebhookSubscription.mockResolvedValue({
      outcome: "subscribed",
    });

    const result = (await mocks.handlerRef.current!({ step })) as {
      checked: number;
      renewed: number;
    };

    expect(mocks.provisionWebhookSubscription).toHaveBeenCalledTimes(2);
    expect(mocks.provisionWebhookSubscription).toHaveBeenCalledWith("c1", "o1");
    expect(result).toEqual({ checked: 2, renewed: 2 });
  });

  it("marks a subscription error when it can no longer be provisioned", async () => {
    const execute = mockExpiringRows([
      { id: "ws1", connection_id: "c1", org_id: "o1" },
    ]);
    mocks.provisionWebhookSubscription.mockResolvedValue({
      outcome: "skipped",
      reason: "no_usable_credential",
    });

    const result = (await mocks.handlerRef.current!({ step })) as {
      checked: number;
      renewed: number;
    };

    expect(result).toEqual({ checked: 1, renewed: 0 });
    // Two execute calls: the find query + the UPDATE ... status='error'.
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("marks a subscription error when re-provisioning throws", async () => {
    const execute = mockExpiringRows([
      { id: "ws1", connection_id: "c1", org_id: "o1" },
    ]);
    mocks.provisionWebhookSubscription.mockRejectedValue(
      new Error("provider 500"),
    );

    const result = (await mocks.handlerRef.current!({ step })) as {
      checked: number;
      renewed: number;
    };

    // A throw is caught per-row and does not abort the cron.
    expect(result).toEqual({ checked: 1, renewed: 0 });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("no-ops cleanly when nothing is expiring", async () => {
    mockExpiringRows([]);
    const result = (await mocks.handlerRef.current!({ step })) as {
      checked: number;
      renewed: number;
    };
    expect(result).toEqual({ checked: 0, renewed: 0 });
    expect(mocks.provisionWebhookSubscription).not.toHaveBeenCalled();
  });
});
