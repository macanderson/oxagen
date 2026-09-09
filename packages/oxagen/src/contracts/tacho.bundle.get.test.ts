import { describe, expect, it } from "vitest";
import { tachoBundleGet } from "./tacho.bundle.get";

const HOST = "tch_0123456789abcdefghjkmn";

function bundle() {
  return {
    schema: "tacho.bundle.v1",
    version: 1,
    etag: "abc",
    issued_at: "2026-09-08T10:00:00.000Z",
    expires_at: "2026-09-09T10:00:00.000Z",
    host_enrollment_id: HOST,
    host_status: "active",
    deny_generation: { org: 1, workspace: 1 },
    permissions: { allow: [], deny: ["Bash(rm -rf *)"], ask: [] },
    tools: { Bash: { risk_grade: "high", read_only: false } },
    budget: { mode: "observed" },
    context: { system: null },
    retention: { mode: "digest_only", classes: [] },
    mode: "observe",
    signature: { key_id: "k", alg: "ed25519", sig: "c2ln" },
  };
}

describe("tachoBundleGet", () => {
  it("accepts a host id with an optional etag", () => {
    expect(
      tachoBundleGet.input.parse({ host_enrollment_id: HOST }).etag,
    ).toBeUndefined();
    expect(
      tachoBundleGet.input.parse({ host_enrollment_id: HOST, etag: "abc" })
        .etag,
    ).toBe("abc");
    expect(
      tachoBundleGet.input.safeParse({ host_enrollment_id: "tch_short" })
        .success,
    ).toBe(false);
  });

  it("carries a bundle exactly when it is modified", () => {
    expect(
      tachoBundleGet.output.safeParse({
        not_modified: false,
        etag: "abc",
        bundle: bundle(),
      }).success,
    ).toBe(true);
    expect(
      tachoBundleGet.output.safeParse({
        not_modified: true,
        etag: "abc",
        bundle: null,
      }).success,
    ).toBe(true);
    expect(
      tachoBundleGet.output.safeParse({
        not_modified: true,
        etag: "abc",
        bundle: bundle(),
      }).success,
    ).toBe(false);
    expect(
      tachoBundleGet.output.safeParse({
        not_modified: false,
        etag: "abc",
        bundle: null,
      }).success,
    ).toBe(false);
  });

  it("refuses a bundle with an unknown member or a non-ed25519 signature", () => {
    expect(
      tachoBundleGet.output.safeParse({
        not_modified: false,
        etag: "a",
        bundle: { ...bundle(), extra: 1 },
      }).success,
    ).toBe(false);
    expect(
      tachoBundleGet.output.safeParse({
        not_modified: false,
        etag: "a",
        bundle: {
          ...bundle(),
          signature: { key_id: "k", alg: "hmac", sig: "x" },
        },
      }).success,
    ).toBe(false);
    expect(tachoBundleGet.name).toBe("get_tacho_bundle");
  });
});
