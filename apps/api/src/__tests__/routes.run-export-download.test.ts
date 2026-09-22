/**
 * GET /v1/run-exports/download: the session-free route behind
 * get_run_export's URL (spec §13.4, ADR-058). The signed token is the only
 * boundary, so every refusal is one 404 and a good token streams the zip with
 * its digest named.
 */
import { describe, expect, it, vi } from "vitest";
import {
  mintRunExportDownloadToken,
  type OpenRunExportDownloadDeps,
} from "@oxagen/handlers/lib/run-export-download";
import { createRunExportDownloadRoute } from "../routes/v1/run.export.download";

const SECRET = "a-test-secret-of-some-length";
const DIGEST = `sha256:${"d".repeat(64)}`;
const claims = {
  exportId: "rexp_0123456789abcdefghjkmn",
  orgId: "0192d4a8-7c1e-7a00-8000-000000000001",
  workspaceId: "0192d4a8-7c1e-7a00-8000-000000000002",
  bundleDigest: DIGEST,
  exp: 2_000,
};

function route(now = 1_000) {
  const bytes = new Uint8Array([80, 75, 3, 4]);
  const deps: OpenRunExportDownloadDeps = {
    secret: () => SECRET,
    nowSeconds: () => now,
    readRow: vi.fn(() =>
      Promise.resolve({
        runPublicId: "arun_5f0c2e9a1b7d4c3e8f6a02",
        status: "ready",
        bundleRef: "evidence/x.zip",
        bundleDigest: DIGEST,
        bundleBytes: bytes.byteLength,
      }),
    ),
    getObject: vi.fn(() =>
      Promise.resolve({
        body: new Response(bytes).body as ReadableStream<Uint8Array>,
        sizeBytes: bytes.byteLength,
      }),
    ),
  };
  return { app: createRunExportDownloadRoute(deps), deps, bytes };
}

describe("GET /v1/run-exports/download", () => {
  it("streams the bundle for a good token with its digest, length and a download name", async () => {
    const { app, bytes } = route();
    const token = mintRunExportDownloadToken(claims, SECRET);
    const res = await app.request(`/?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("x-bundle-digest")).toBe(DIGEST);
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="arun_5f0c2e9a1b7d4c3e8f6a02-rexp_0123456789abcdefghjkmn.zip"',
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    ["no token", "/"],
    ["a forged token", "/?token=abc.def"],
    [
      "a token signed with another secret",
      `/?token=${mintRunExportDownloadToken(claims, "another-secret-value")}`,
    ],
  ])(
    "answers 404 for %s without reading a row (negative)",
    async (_l, path) => {
      const { app, deps } = route();
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(deps.readRow).not.toHaveBeenCalled();
    },
  );

  it("answers 404 for an expired token (negative)", async () => {
    const { app, deps } = route(2_000);
    const res = await app.request(
      `/?token=${mintRunExportDownloadToken(claims, SECRET)}`,
    );
    expect(res.status).toBe(404);
    expect(deps.getObject).not.toHaveBeenCalled();
  });
});
