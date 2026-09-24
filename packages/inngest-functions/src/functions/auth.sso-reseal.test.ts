import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  resealSsoProviders: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));
vi.mock("@oxagen/database/sso-reseal", () => ({
  resealSsoProviders: mocks.resealSsoProviders,
}));
vi.mock("../logger", () => ({ logger: mocks.logger }));

type Handler = (ctx: {
  step: { run: (name: string, fn: () => unknown) => Promise<unknown> };
}) => Promise<unknown>;

const registered: {
  opts: { id: string };
  trigger: unknown;
  handler: Handler;
}[] = [];
mocks.createFunction.mockImplementation(
  (opts: { id: string }, trigger: unknown, handler: Handler) => {
    registered.push({ opts, trigger, handler });
    return [{ id: opts.id }];
  },
);

const { SSO_RESEAL_REQUESTED_EVENT } = await import("./auth.sso-reseal");

const step = {
  run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("auth.sso-reseal", () => {
  it("runs daily and on the operator's request event", () => {
    expect(registered.map((r) => [r.opts.id, r.trigger])).toEqual([
      ["auth/sso-reseal-daily", { cron: "30 3 * * *" }],
      ["auth/sso-reseal-requested", { event: SSO_RESEAL_REQUESTED_EVENT }],
    ]);
  });

  it("returns the re-seal counts and logs a clean run", async () => {
    const result = { scanned: 3, resealed: 2, failed: [] };
    mocks.resealSsoProviders.mockResolvedValue(result);
    await expect(registered[0]!.handler({ step })).resolves.toEqual(result);
    expect(step.run).toHaveBeenCalledWith(
      "reseal-sso-providers",
      expect.any(Function),
    );
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("logs each provider left on a retired key without failing the run", async () => {
    const result = {
      scanned: 2,
      resealed: 1,
      failed: [{ providerId: "broken", reason: 'key id "sso_v0"' }],
    };
    mocks.resealSsoProviders.mockResolvedValue(result);
    await expect(registered[1]!.handler({ step })).resolves.toEqual(result);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "event", failed: result.failed }),
      expect.any(String),
    );
  });

  it("reports a skipped run when no key is configured", async () => {
    mocks.resealSsoProviders.mockResolvedValue({
      scanned: 0,
      resealed: 0,
      failed: [],
      skipped: "AUTH_TOKEN_ENCRYPTION_KEY is not set",
    });
    const out = (await registered[0]!.handler({ step })) as {
      skipped?: string;
    };
    expect(out.skipped).toMatch(/AUTH_TOKEN_ENCRYPTION_KEY/);
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });
});
