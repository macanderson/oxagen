/**
 * get_run_export and its download token: the status read, the org role gate,
 * a foreign export id, and the signed URL that must refuse a forged, expired
 * or re-pointed token (ARCHITECTURE.md §3.2; spec §13.4).
 */
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { runExportGet } from "@oxagen/oxagen/contracts/run.export.get";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  createRunExportGetHandler,
  type RunExportGetDeps,
  type RunExportRow,
} from "./run.export.get";
import {
  mintRunExportDownloadToken,
  openRunExportDownload,
  type OpenRunExportDownloadDeps,
  RUN_EXPORT_DOWNLOAD_PATH,
  runExportDownloadUrl,
  verifyRunExportDownloadToken,
} from "./lib/run-export-download";
import { ctx, roleTx } from "./run.test-support";

const SECRET = "a-test-secret-of-some-length";
const NOW = new Date("2026-09-22T12:00:00.000Z");
const EXPORT_ID = "rexp_0123456789abcdefghjkmn";
const DIGEST = `sha256:${"d".repeat(64)}`;

function row(over: Partial<RunExportRow> = {}): RunExportRow {
  return {
    publicId: EXPORT_ID,
    runPublicId: "arun_5f0c2e9a1b7d4c3e8f6a02",
    status: "ready",
    createdAt: new Date("2026-09-22T11:58:00.000Z"),
    completedAt: new Date("2026-09-22T11:59:00.000Z"),
    bundleDigest: DIGEST,
    bundleBytes: 4096,
    merkleRoot: `sha256:${"e".repeat(64)}`,
    frameCount: 3,
    error: null,
    ...over,
  };
}

function harness(role: string | null, found: RunExportRow | null = row()) {
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(roleTx(role))),
  );
  const readExport = vi.fn<RunExportGetDeps["readExport"]>(() =>
    Promise.resolve(found),
  );
  return {
    handler: createRunExportGetHandler({
      readExport,
      secret: () => SECRET,
      now: () => NOW,
    }),
    readExport,
  };
}

describe("get_run_export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["NEXT_PUBLIC_API_URL"];
  });

  it("answers a ready export with its size, digest and a download URL that expires in fifteen minutes", async () => {
    const h = harness("Owner");
    const out = await h.handler({ exportId: EXPORT_ID }, ctx());
    expect(runExportGet.output.parse(out)).toEqual(out);
    expect(h.readExport).toHaveBeenCalledWith({
      orgId: ctx().orgId,
      workspaceId: ctx().workspaceId,
      exportId: EXPORT_ID,
    });
    expect(out).toMatchObject({
      status: "ready",
      bundleBytes: 4096,
      bundleDigest: DIGEST,
      frameCount: 3,
      error: null,
    });
    expect(out.download?.expiresAt).toBe("2026-09-22T12:15:00.000Z");
    const token = new URL(out.download?.url ?? "", "http://x").searchParams.get(
      "token",
    );
    expect(out.download?.url.startsWith(RUN_EXPORT_DOWNLOAD_PATH)).toBe(true);
    expect(
      verifyRunExportDownloadToken(token ?? "", SECRET, NOW.getTime() / 1000),
    ).toEqual({
      exportId: EXPORT_ID,
      orgId: ctx().orgId,
      workspaceId: ctx().workspaceId,
      bundleDigest: DIGEST,
      exp: NOW.getTime() / 1000 + 900,
    });
  });

  it.each(["queued", "building"])(
    "answers a %s export with no download",
    async (status) => {
      const h = harness(
        "Admin",
        row({ status, bundleDigest: null, completedAt: null }),
      );
      const out = await h.handler({ exportId: EXPORT_ID }, ctx());
      expect(out).toMatchObject({ status, download: null, completedAt: null });
    },
  );

  it("answers a failed export with the job's error and no download", async () => {
    const h = harness(
      "Admin",
      row({ status: "failed", bundleDigest: null, error: "no attester key" }),
    );
    const out = await h.handler({ exportId: EXPORT_ID }, ctx());
    expect(out).toMatchObject({
      status: "failed",
      error: "no attester key",
      download: null,
    });
  });

  it("reads an export id from another workspace as not_found (negative)", async () => {
    const h = harness("Owner", null);
    await expect(h.handler({ exportId: EXPORT_ID }, ctx())).rejects.toSatisfy(
      (e: unknown) =>
        isHandlerError(e) &&
        e.code === "not_found" &&
        e.reason === "run_export_not_found",
    );
  });

  it("refuses a Member before reading anything (negative)", async () => {
    const h = harness("Member");
    await expect(h.handler({ exportId: EXPORT_ID }, ctx())).rejects.toSatisfy(
      (e: unknown) => isHandlerError(e) && e.code === "forbidden",
    );
    expect(h.readExport).not.toHaveBeenCalled();
  });

  it("puts the URL on the API's public origin when it is known", () => {
    process.env["NEXT_PUBLIC_API_URL"] = "https://api.example.test/some/path";
    expect(runExportDownloadUrl("abc")).toBe(
      "https://api.example.test/v1/run-exports/download?token=abc",
    );
  });
});

describe("the run export download token", () => {
  const claims = {
    exportId: EXPORT_ID,
    orgId: "org",
    workspaceId: "ws",
    bundleDigest: DIGEST,
    exp: 2_000,
  };

  it("round-trips before it expires and refuses at and after expiry", () => {
    const token = mintRunExportDownloadToken(claims, SECRET);
    expect(verifyRunExportDownloadToken(token, SECRET, 1_999)).toEqual(claims);
    expect(verifyRunExportDownloadToken(token, SECRET, 2_000)).toBeNull();
  });

  it("refuses another secret, edited claims and junk (negative)", () => {
    const token = mintRunExportDownloadToken(claims, SECRET);
    expect(verifyRunExportDownloadToken(token, "other-secret", 0)).toBeNull();
    const [, sig] = token.split(".");
    const forged = `${Buffer.from(
      JSON.stringify({ ...claims, orgId: "someone-else" }),
    ).toString("base64url")}.${sig}`;
    expect(verifyRunExportDownloadToken(forged, SECRET, 0)).toBeNull();
    expect(verifyRunExportDownloadToken("no-dot", SECRET, 0)).toBeNull();
    expect(verifyRunExportDownloadToken("a.b.c", SECRET, 0)).toBeNull();
  });

  describe("opening a bundle", () => {
    const body = new ReadableStream<Uint8Array>();
    function deps(
      found: Awaited<ReturnType<OpenRunExportDownloadDeps["readRow"]>>,
    ): OpenRunExportDownloadDeps {
      return {
        secret: () => SECRET,
        nowSeconds: () => 1_000,
        readRow: vi.fn(() => Promise.resolve(found)),
        getObject: vi.fn(() => Promise.resolve({ body, sizeBytes: 10 })),
      };
    }
    const ready = {
      runPublicId: "arun_5f0c2e9a1b7d4c3e8f6a02",
      status: "ready",
      bundleRef: "evidence/org/ws/exports/x.zip",
      bundleDigest: DIGEST,
      bundleBytes: 4096,
    };

    it("streams a ready bundle, named for the run and the export", async () => {
      const d = deps(ready);
      const opened = await openRunExportDownload(
        mintRunExportDownloadToken(claims, SECRET),
        d,
      );
      expect(opened).toEqual({
        body,
        bytes: 4096,
        bundleDigest: DIGEST,
        filename: `arun_5f0c2e9a1b7d4c3e8f6a02-${EXPORT_ID}.zip`,
      });
      expect(d.readRow).toHaveBeenCalledWith(claims);
      expect(d.getObject).toHaveBeenCalledWith(ready.bundleRef);
    });

    it("refuses a forged token without reading the row (negative)", async () => {
      const d = deps(ready);
      expect(await openRunExportDownload("x.y", d)).toBeNull();
      expect(d.readRow).not.toHaveBeenCalled();
    });

    it.each([
      ["a missing row", null],
      ["a row that is not ready", { ...ready, status: "building" }],
      [
        "a row whose digest moved",
        { ...ready, bundleDigest: `sha256:${"0".repeat(64)}` },
      ],
    ])("refuses %s (negative)", async (_label, found) => {
      const d = deps(found);
      expect(
        await openRunExportDownload(
          mintRunExportDownloadToken(claims, SECRET),
          d,
        ),
      ).toBeNull();
      expect(d.getObject).not.toHaveBeenCalled();
    });
  });
});
