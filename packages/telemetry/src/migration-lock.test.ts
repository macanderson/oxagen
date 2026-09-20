import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEnv: vi.fn(() => ({ DATABASE_URL: "postgres://local/coordination" })),
  query: vi.fn<(parts: TemplateStringsArray) => Promise<unknown[]>>(
    async () => [],
  ),
  begin: vi.fn(),
  end: vi.fn(async () => undefined),
  postgres: vi.fn(),
}));
vi.mock("@oxagen/config/env", () => ({ requireEnv: mocks.requireEnv }));
vi.mock("postgres", () => ({ default: mocks.postgres }));
import { withMigrationLock } from "./migration-lock";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.postgres.mockReturnValue({ begin: mocks.begin, end: mocks.end });
  mocks.begin.mockImplementation(
    async (run: (tx: unknown) => Promise<unknown>) => run(mocks.query),
  );
});

describe("migration coordination lock", () => {
  it("waits for the lock before running and returns the result", async () => {
    const run = vi.fn(async () => 42);
    let release: () => void = () => undefined;
    mocks.query.mockImplementationOnce(
      () =>
        new Promise<never[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    const result = withMigrationLock(run);
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    release();
    await expect(result).resolves.toBe(42);
    expect(mocks.query.mock.calls[0]?.[0]).toEqual([
      "SELECT pg_advisory_xact_lock(1869768558, 2687)",
    ]);
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("does not run DDL if the lock fails and closes the connection", async () => {
    mocks.query.mockRejectedValueOnce(new Error("lock unavailable"));
    const run = vi.fn();
    await expect(withMigrationLock(run)).rejects.toThrow("lock unavailable");
    expect(run).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("releases the connection after migration failure", async () => {
    await expect(
      withMigrationLock(async () => {
        throw new Error("DDL failed");
      }),
    ).rejects.toThrow("DDL failed");
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("requires a coordinator before opening any connection", async () => {
    mocks.requireEnv.mockImplementationOnce(() => {
      throw new Error("DATABASE_URL is required");
    });
    const run = vi.fn();
    await expect(withMigrationLock(run)).rejects.toThrow("DATABASE_URL");
    expect(mocks.postgres).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
