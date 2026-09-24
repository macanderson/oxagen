// tacho.events.ingest-audit-fix.test.ts — a batch whose own values Postgres
// refuses is answered as a refused input (400), which the host's shipper
// bisects down to the one event and quarantines, and never as the 500 it
// retried for ever. Any other error leaves the handler unchanged.
import type { CapabilityContext } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { DrizzleQueryError } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  insertTachoEvents: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...original,
    withTenantDb: mocks.withTenantDb,
    withOrgDb: mocks.withTenantDb,
  };
});
vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/telemetry")>();
  return { ...original, insertTachoEvents: mocks.insertTachoEvents };
});
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { tachoEventsIngestHandler } from "./tacho.events.ingest";

const HOST_PUBLIC = "tch_0123456789abcdefghjkmn";
const CONTEXT: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: null,
  apiKeyId: "aky_host",
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

/** The read-only transaction that resolves the host before any write. */
const hostTx = {
  execute: async () => [{ "?column?": 1 }],
  select: () => ({ from: () => ({ where: async () => [] }) }),
  query: {
    apiKeys: {
      findFirst: async () => ({
        id: "aky_host",
        scope: { purpose: "tacho_host_v1", host_enrollment_id: HOST_PUBLIC },
      }),
    },
    tachoHosts: {
      findFirst: async () => ({
        id: "11111111-1111-4111-8111-111111111111",
        publicId: HOST_PUBLIC,
        apiKeyId: "aky_host",
        status: "active",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      }),
    },
    retentionPolicyVersions: { findFirst: async () => undefined },
  },
};

/** The projection transaction fails with `code` under the drizzle wrapper. */
function projectionFails(code: string): void {
  mocks.withTenantDb
    .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(hostTx),
    )
    .mockImplementationOnce(async () => {
      throw new DrizzleQueryError(
        'insert into "tacho"."session_models" ("api_duration_ms") values ($1)',
        [4_294_967_295],
        Object.assign(new Error("integer out of range"), { code }),
      );
    });
}

const batch = {
  schema: "tacho.batch.v1" as const,
  host_enrollment_id: HOST_PUBLIC,
  events: [],
};

beforeEach(() => {
  mocks.withTenantDb.mockReset();
  mocks.insertTachoEvents.mockReset();
});

describe("ingest_tacho_events", () => {
  it.each(["22003", "23514"])(
    "answers a batch Postgres cannot store (SQLSTATE %s) as a refused input",
    async (code) => {
      projectionFails(code);
      const err = await tachoEventsIngestHandler(batch as never, CONTEXT).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).code).toBe("invalid_input");
      expect((err as Error).message).toContain(`SQLSTATE ${code}`);
      expect(mocks.insertTachoEvents).not.toHaveBeenCalled();
    },
  );

  it("passes any other failure through unchanged (negative)", async () => {
    projectionFails("40001");
    const err = await tachoEventsIngestHandler(batch as never, CONTEXT).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DrizzleQueryError);
  });
});
