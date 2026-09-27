/**
 * steeringWriter decides whether a registry write opens a steering PR or
 * writes a row directly (M13, #4478). It hands back the writer only when all
 * four conditions hold, and each test below takes one of them away.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import {
  countMovableLegacyServers,
  registerServerFolderWriter,
  registerSteeringPrOpener,
  steeringPrOpener,
  steeringWriter,
  SteeringPrUnavailableError,
  type ServerFolderWriter,
  type SteeringPrOpener,
} from "./steering-pr";

const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };

let where: SQL | undefined;

/** A select chain that records its WHERE and resolves to one count row. */
function countTx(n: number | string | undefined): unknown {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    from: () => chain,
    leftJoin: () => chain,
    where: (w: SQL) => {
      where = w;
      return Promise.resolve(n === undefined ? [] : [{ n }]);
    },
  });
  return chain;
}

function useCount(n: number | string | undefined): void {
  mocks.withTenantDb.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(countTx(n)));
}

function opener(hasRepo: boolean): SteeringPrOpener {
  return {
    hasSteeringRepo: vi.fn().mockResolvedValue(hasRepo),
    open: vi.fn(),
    readFile: vi.fn(),
  };
}

const WRITER: ServerFolderWriter = { addServer: vi.fn(), addTools: vi.fn() };

describe("steeringWriter", () => {
  beforeEach(() => {
    mocks.withTenantDb.mockReset();
    where = undefined;
    useCount(0);
  });

  afterEach(() => {
    registerSteeringPrOpener(null);
    registerServerFolderWriter(null);
  });

  it("returns null when no opener is registered", async () => {
    registerServerFolderWriter(WRITER);

    expect(await steeringWriter(SCOPE)).toBeNull();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("returns null when no writer is registered", async () => {
    const o = opener(true);
    registerSteeringPrOpener(o);

    expect(await steeringWriter(SCOPE)).toBeNull();
    expect(o.hasSteeringRepo).not.toHaveBeenCalled();
  });

  it("returns null when the workspace has no steering repo", async () => {
    const o = opener(false);
    registerSteeringPrOpener(o);
    registerServerFolderWriter(WRITER);

    expect(await steeringWriter(SCOPE)).toBeNull();
    expect(o.hasSteeringRepo).toHaveBeenCalledWith(SCOPE);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("returns null while a legacy row is left to move", async () => {
    registerSteeringPrOpener(opener(true));
    registerServerFolderWriter(WRITER);
    useCount(2);

    expect(await steeringWriter(SCOPE)).toBeNull();
  });

  it("reads a count Postgres returns as text", async () => {
    registerSteeringPrOpener(opener(true));
    registerServerFolderWriter(WRITER);
    useCount("1");

    expect(await steeringWriter(SCOPE)).toBeNull();
  });

  it("returns the writer once every condition holds", async () => {
    registerSteeringPrOpener(opener(true));
    registerServerFolderWriter(WRITER);

    expect(await steeringWriter(SCOPE)).toBe(WRITER);
  });

  it("exposes the registered opener and removes it on null", () => {
    const o = opener(true);
    registerSteeringPrOpener(o);
    expect(steeringPrOpener()).toBe(o);

    registerSteeringPrOpener(null);
    expect(steeringPrOpener()).toBeNull();
  });
});

describe("countMovableLegacyServers", () => {
  beforeEach(() => {
    where = undefined;
  });

  it("counts live, enabled, legacy rows on a remote transport", async () => {
    const n = await countMovableLegacyServers(countTx(3) as never, SCOPE);

    expect(n).toBe(3);
    const q = new PgDialect().sqlToQuery(where as SQL);
    expect(q.sql).toMatch(/"origin" = \$\d+/);
    expect(q.sql).toMatch(/"enabled" = \$\d+/);
    expect(q.sql).toMatch(/"deleted_at" is null/);
    expect(q.sql).toMatch(/"transport_type" in \(\$\d+, \$\d+\)/);
    expect(q.params).toEqual(
      expect.arrayContaining(["org-1", "ws-1", "legacy", true, "streamable-http", "sse"]),
    );
  });

  it("reads no row as zero", async () => {
    expect(await countMovableLegacyServers(countTx(undefined) as never, SCOPE)).toBe(0);
  });
});

describe("SteeringPrUnavailableError", () => {
  it("carries the code handlers refuse with", () => {
    const err = new SteeringPrUnavailableError("no steering repo");

    expect(err.code).toBe("steering_pr_unavailable");
    expect(err.name).toBe("SteeringPrUnavailableError");
    expect(err.message).toBe("no steering repo");
  });
});
