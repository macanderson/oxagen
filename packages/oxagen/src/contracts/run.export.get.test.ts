import { describe, expect, it } from "vitest";
import {
  RUN_EXPORT_DOWNLOAD_TTL_SECONDS,
  runExportGet,
} from "./run.export.get";

const ready = {
  exportId: "rexp_0a1b2c",
  runId: "arun_5f0c2e9a1b7d4c3e8f6a02",
  status: "ready",
  createdAt: "2026-09-22T11:58:00.000Z",
  completedAt: "2026-09-22T11:59:00.000Z",
  bundleDigest: `sha256:${"d".repeat(64)}`,
  bundleBytes: 4096,
  merkleRoot: `sha256:${"e".repeat(64)}`,
  frameCount: 3,
  error: null,
  download: {
    url: "https://api.example.test/v1/run-exports/download?token=a.b",
    expiresAt: "2026-09-22T12:15:00.000Z",
  },
};

describe("get_run_export contract", () => {
  it("is a read on api, mcp and cli, restricted to org Owner and Admin", () => {
    expect(runExportGet.mode).toBe("sync");
    expect(runExportGet.mutates).toBe(false);
    expect(runExportGet.noBillingGate).toBe(true);
    expect(runExportGet.sensitivity).toBe("high");
    expect(runExportGet.surfaces).toEqual(["api", "mcp", "cli"]);
    expect(runExportGet.defaultRoles?.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
    expect(RUN_EXPORT_DOWNLOAD_TTL_SECONDS).toBe(900);
  });

  it("takes an export id, never a run id", () => {
    expect(
      runExportGet.input.safeParse({ exportId: "rexp_0a1b2c" }).success,
    ).toBe(true);
    expect(
      runExportGet.input.safeParse({ exportId: "arun_5f0c2e9a1b7d4c3e8f6a02" })
        .success,
    ).toBe(false);
  });

  it("answers the four stored statuses and nothing else (negative)", () => {
    expect(runExportGet.output.safeParse(ready).success).toBe(true);
    expect(
      runExportGet.output.safeParse({
        ...ready,
        status: "failed",
        error: "no attester key",
        download: null,
      }).success,
    ).toBe(true);
    expect(
      runExportGet.output.safeParse({ ...ready, status: "expired" }).success,
    ).toBe(false);
    expect(
      runExportGet.output.safeParse({ ...ready, bundleDigest: "md5:abc" })
        .success,
    ).toBe(false);
  });
});
