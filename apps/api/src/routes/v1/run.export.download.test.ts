// GET /v1/run-exports/download: the token is the boundary, and the row it
// names is read by the same select `get_run_export` answers from, inside the
// token's tenant. The download's own verdicts (a forged, expired or
// digest-moved token) are proven on `openRunExportDownload` in
// packages/handlers; this file holds the route's wiring.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mintRunExportDownloadToken } from "@oxagen/handlers/lib/run-export-download";

const mocks = vi.hoisted(() => ({
  readRunExportRow: vi.fn(),
  runInTenantScope: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@oxagen/handlers/run.export.get", () => ({
  readRunExportRow: mocks.readRunExportRow,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));
vi.mock("@oxagen/storage", () => ({ storage: () => ({ get: mocks.get }) }));

import { runExportDownloadRoute } from "./run.export.download";

const SECRET = "run-export-download-test-secret-0123456789";
const ORG = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const EXPORT_ID = "rexp_0123456789abcdefghjkmn";
const DIGEST = `sha256:${"a".repeat(64)}`;

function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function token(
  over: Partial<Parameters<typeof mintRunExportDownloadToken>[0]> = {},
) {
  return mintRunExportDownloadToken(
    {
      exportId: EXPORT_ID,
      orgId: ORG,
      workspaceId: WORKSPACE,
      bundleDigest: DIGEST,
      exp: Math.floor(Date.now() / 1000) + 600,
      ...over,
    },
    SECRET,
  );
}

async function get(query: string): Promise<Response> {
  return await runExportDownloadRoute.fetch(
    new Request(`http://localhost/?${query}`, { method: "GET" }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env["AUDIT_EXPORT_SIGNING_SECRET"] = SECRET;
  mocks.runInTenantScope.mockImplementation((_scope, fn: () => unknown) =>
    fn(),
  );
  mocks.readRunExportRow.mockResolvedValue({
    publicId: EXPORT_ID,
    runPublicId: "arun_5f0c2e9a1b7d4c3e8f6a02",
    status: "ready",
    createdAt: new Date("2026-09-22T10:00:00.000Z"),
    completedAt: new Date("2026-09-22T10:01:00.000Z"),
    bundleRef: "run-exports/bundle.zip",
    bundleDigest: DIGEST,
    bundleBytes: 9,
    merkleRoot: null,
    frameCount: 3,
    error: null,
  });
  mocks.get.mockResolvedValue({ body: bodyOf("zip-bytes"), sizeBytes: 9 });
});

describe("GET /v1/run-exports/download", () => {
  it("reads the export through get_run_export's row read, inside the token's tenant", async () => {
    const res = await get(`token=${encodeURIComponent(token())}`);

    expect(res.status).toBe(200);
    expect(mocks.runInTenantScope).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WORKSPACE },
      expect.any(Function),
    );
    expect(mocks.readRunExportRow).toHaveBeenCalledWith({
      orgId: ORG,
      workspaceId: WORKSPACE,
      exportId: EXPORT_ID,
    });
    expect(mocks.get).toHaveBeenCalledWith("run-exports/bundle.zip");
    expect(res.headers.get("x-bundle-digest")).toBe(DIGEST);
    expect(res.headers.get("content-length")).toBe("9");
    expect(await res.text()).toBe("zip-bytes");
  });

  it("answers one 404 for a token it cannot verify, without a row read", async () => {
    const res = await get(`token=${encodeURIComponent(token())}x`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mocks.readRunExportRow).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("answers 404 when the row's digest is not the token's", async () => {
    const res = await get(
      `token=${encodeURIComponent(token({ bundleDigest: `sha256:${"b".repeat(64)}` }))}`,
    );

    expect(res.status).toBe(404);
    expect(mocks.readRunExportRow).toHaveBeenCalledTimes(1);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
