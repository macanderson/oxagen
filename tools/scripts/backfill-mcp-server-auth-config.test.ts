/**
 * Unit tests for the pure backfill-detection core of
 * tools/scripts/backfill-mcp-server-auth-config.ts (OXA-1982).
 */
import { describe, it, expect } from "vitest";
import {
  needsBackfill,
  partitionRows,
} from "./lib/backfill-mcp-server-auth-config";

describe("needsBackfill", () => {
  it("returns false for an empty auth_config ({}, null, undefined)", () => {
    expect(needsBackfill({})).toBe(false);
    expect(needsBackfill(null)).toBe(false);
    expect(needsBackfill(undefined)).toBe(false);
  });

  it("returns false for an already-encrypted auth_config", () => {
    expect(
      needsBackfill({
        v: 1,
        kmsKeyId: "mcp_server_auth_v1",
        ciphertext: "base64==",
      }),
    ).toBe(false);
  });

  it("returns true for a legacy plaintext auth_config", () => {
    expect(needsBackfill({ token: "some-bearer-token" })).toBe(true);
    expect(needsBackfill({ "x-api-key": "abc123" })).toBe(true);
  });

  it("returns false for non-object values (defensive — should never occur for a jsonb column)", () => {
    expect(needsBackfill("not-an-object")).toBe(false);
    expect(needsBackfill(42)).toBe(false);
  });
});

describe("partitionRows", () => {
  it("splits rows into toConvert (legacy plaintext) and alreadyOk (empty or encrypted)", () => {
    const rows = [
      { id: "1", publicId: "mcs_1", authConfig: { token: "plaintext-secret" } },
      { id: "2", publicId: "mcs_2", authConfig: {} },
      {
        id: "3",
        publicId: "mcs_3",
        authConfig: { v: 1, kmsKeyId: "k", ciphertext: "c" },
      },
      {
        id: "4",
        publicId: "mcs_4",
        authConfig: { "x-header": "another-plaintext-secret" },
      },
    ];

    const { toConvert, alreadyOk } = partitionRows(rows);

    expect(toConvert.map((r) => r.publicId)).toEqual(["mcs_1", "mcs_4"]);
    expect(alreadyOk.map((r) => r.publicId)).toEqual(["mcs_2", "mcs_3"]);
  });

  it("returns empty arrays for an empty input", () => {
    const { toConvert, alreadyOk } = partitionRows([]);
    expect(toConvert).toEqual([]);
    expect(alreadyOk).toEqual([]);
  });
});
