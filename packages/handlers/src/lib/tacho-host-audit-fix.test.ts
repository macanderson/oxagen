// tacho-host-audit-fix.test.ts — the refusals a host keys on: a revoked
// enrollment answers `forbidden` with the `host_revoked` reason, and a
// Postgres data error a batch's own values raised is mapped to a refused
// input, found down drizzle's cause chain, while every other error passes
// through unchanged. The command lease and the acknowledgement order run
// against Postgres in tacho.command.audit-fix.pg.test.ts.
import type { CapabilityContext } from "@oxagen/oxagen";
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  TACHO_HOST_REVOKED,
  resolveEnrolledHost,
  unstorableBatch,
} from "./tacho-host";

const HOST_PUBLIC = "tch_0123456789abcdefghjkmn";
const MACHINE: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: null,
  apiKeyId: "aky_host",
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

function txWithHost(status: string) {
  return {
    // The gateway-column probe: every column present.
    execute: async () => [{ "?column?": 1 }],
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
          status,
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        }),
      },
    },
  };
}

/** A driver error as postgres.js raises it, wrapped the way drizzle wraps it. */
function wrapped(code: string): Error {
  return new DrizzleQueryError(
    'update "tacho"."session_models" set "api_duration_ms" = $1',
    [4_294_967_295],
    Object.assign(new Error("integer out of range"), { code }),
  );
}

describe("resolveEnrolledHost", () => {
  it("refuses a revoked host with the host_revoked reason", async () => {
    const err = await resolveEnrolledHost(
      "ingest_tacho_events",
      MACHINE,
      txWithHost("revoked") as never,
      HOST_PUBLIC,
    ).catch((e: unknown) => e);
    expect(isHandlerError(err) && [err.code, err.reason]).toEqual([
      "forbidden",
      TACHO_HOST_REVOKED,
    ]);
    expect((err as Error).message).toMatch(/revoked/);
  });

  it("resolves an active host (negative)", async () => {
    const host = await resolveEnrolledHost(
      "ingest_tacho_events",
      MACHINE,
      txWithHost("active") as never,
      HOST_PUBLIC,
    );
    expect(host.publicId).toBe(HOST_PUBLIC);
  });
});

describe("unstorableBatch", () => {
  it.each(["22003", "22001", "22P02", "23514"])(
    "maps SQLSTATE %s under the drizzle wrapper to a refused input",
    (code) => {
      const refusal = unstorableBatch("ingest_tacho_events", wrapped(code));
      expect(refusal).toBeInstanceOf(CapabilityError);
      expect(refusal?.code).toBe("invalid_input");
      expect(refusal?.message).toContain(`SQLSTATE ${code}`);
      // The statement and its parameters carry the batch's values.
      expect(refusal?.message).not.toContain("session_models");
      expect(refusal?.message).not.toContain("4294967295");
    },
  );

  it("maps a bare driver error too", () => {
    const bare = Object.assign(new Error("value too long"), { code: "22001" });
    expect(unstorableBatch("ingest_tacho_events", bare)?.code).toBe(
      "invalid_input",
    );
  });

  it.each([
    ["a unique violation", wrapped("23505")],
    ["a serialization failure", wrapped("40001")],
    ["a ClickHouse error code", Object.assign(new Error("x"), { code: "241" })],
    ["a socket error", Object.assign(new Error("x"), { code: "ECONNRESET" })],
    ["a plain error", new Error("boom")],
    ["a non-error", "boom"],
  ])("leaves %s alone (negative)", (_label, err) => {
    expect(unstorableBatch("ingest_tacho_events", err)).toBeUndefined();
  });
});
