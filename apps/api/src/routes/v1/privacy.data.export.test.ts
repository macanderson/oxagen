// The export routes: queue, status, and the download of the archive itself.
//
// The case that earns the download route is the last describe: the bundle is a
// private object, so the status read answers with a storage key and no URL,
// and a key is no use to a token-authenticated client: reading it needs the
// store's credentials. Without this route the API export flow ends with a
// caller who can see that their archive is ready and cannot fetch it.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));
vi.mock("@oxagen/storage", () => ({ storage: () => ({ get: mocks.get }) }));

import { privacyDataExportRoute } from "./privacy.data.export";

const EXPORT_ID = "7a000000-0000-4000-8000-0000000000e1";
const KEY = "privacy-exports/org-1/7a000000.zip";

const fakeCtx = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "00000000-0000-0000-0000-000000000000",
  userId: "22222222-2222-4222-8222-222222222222",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

function ready(overrides: Record<string, unknown> = {}) {
  return {
    exportId: EXPORT_ID,
    status: "ready",
    ready: true,
    storageKey: KEY,
    completedAt: "2026-09-18T22:00:00.000Z",
    ...overrides,
  };
}

function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function get(path: string): Promise<Response> {
  return await privacyDataExportRoute.fetch(
    new Request(`http://localhost${path}`, { method: "GET" }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(ready());
  mocks.get.mockResolvedValue({
    body: bodyOf("zip-bytes"),
    contentType: "application/zip",
    sizeBytes: 9,
  });
});

describe("GET privacy/export/:exportId", () => {
  it("dispatches the capability rather than reading the table", async () => {
    const res = await get(`/${EXPORT_ID}`);
    expect(res.status).toBe(200);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_export_status",
      { exportId: EXPORT_ID },
      fakeCtx,
      { surface: "api" },
    );
    expect(await res.json()).toEqual(ready());
  });

  // The contract's own schema is what refuses this, on every surface. The
  // parse throws, which this route file alone answers as a 500; mounted in
  // app.ts the shared onError maps it to a 400. What matters here is that the
  // capability is never dispatched with an id the contract would not accept.
  it("refuses an id that is not a uuid (negative)", async () => {
    expect((await get("/not-a-uuid")).status).toBe(500);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("GET privacy/export/:exportId/download", () => {
  it("streams the archive from the key the capability gave it", async () => {
    const res = await get(`/${EXPORT_ID}/download`);
    expect(mocks.get).toHaveBeenCalledWith(KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="oxagen-export-${EXPORT_ID}.zip"`,
    );
    expect(await res.text()).toBe("zip-bytes");
  });

  // Authorization is the capability's: it matches the row on the principal and
  // the governed organisation, so someone else's export refuses there and the
  // route never reaches storage.
  it("never touches storage when the capability refuses (negative)", async () => {
    mocks.invoke.mockRejectedValue(new Error("not_found"));
    await get(`/${EXPORT_ID}/download`);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("answers 409 while the bundle is still being written (negative)", async () => {
    mocks.invoke.mockResolvedValue(
      ready({ status: "processing", ready: false, storageKey: null }),
    );
    const res = await get(`/${EXPORT_ID}/download`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "not_ready",
      status: "processing",
    });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("answers 409 for an export that failed (negative)", async () => {
    mocks.invoke.mockResolvedValue(
      ready({ status: "failed", ready: false, storageKey: null }),
    );
    expect((await get(`/${EXPORT_ID}/download`)).status).toBe(409);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  // A data-subject export is never held by a shared cache.
  it("marks the response private and uncacheable", async () => {
    const res = await get(`/${EXPORT_ID}/download`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("falls back to application/zip when the store reports no type", async () => {
    mocks.get.mockResolvedValue({
      body: bodyOf("zip-bytes"),
      contentType: null,
      sizeBytes: null,
    });
    expect(
      (await get(`/${EXPORT_ID}/download`)).headers.get("content-type"),
    ).toBe("application/zip");
  });
});
