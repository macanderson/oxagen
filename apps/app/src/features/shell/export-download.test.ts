// The authenticated download of a data export, over its two seams: the viewer
// resolution and the status read. The case that earns this file is the first
// one in "the bytes": the archive is a private object, so the only way a
// person can receive it is a route that checks who they are and streams it.
// A link straight at storage would 404 on the filesystem driver and 401 on
// Vercel Blob.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrgCtx, type RouteViewer } from "@/server/viewer";
import { unsafeMint } from "@/server/viewer.testing";
import { handleExportDownload } from "./export-download";
import type { ExportObject } from "./export-storage";

const EXPORT_ID = "7a000000-0000-4000-8000-0000000000e1";
const KEY = "privacy-exports/org-1/7a000000.zip";

const resolveViewer = vi.fn<(org: string) => Promise<RouteViewer>>();
const readStatus = vi.fn();
const get = vi.fn<(key: string) => Promise<ExportObject>>();

/** A signed-in viewer of acme. The handler switches on `kind` and never reads
 *  `ctx`, but the type asks for one, so it is minted rather than asserted. */
const OK_VIEWER: RouteViewer = {
  kind: "ok",
  ctx: unsafeMint(OrgCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole: "owner",
  }),
};

/** The blob seam is one narrow read, so there is nothing to stub but that: the
 *  handler cannot write or delete through it however it is called. */
function deps() {
  return { resolveViewer, readStatus, readObject: get };
}

function call() {
  return handleExportDownload(
    new Request("https://app.example/acme/account/export/" + EXPORT_ID),
    { params: Promise.resolve({ org: "acme", exportId: EXPORT_ID }) },
    deps(),
  );
}

function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

beforeEach(() => {
  resolveViewer.mockReset();
  resolveViewer.mockResolvedValue(OK_VIEWER);
  readStatus.mockReset();
  readStatus.mockResolvedValue({
    ok: true,
    value: { ready: true, storageKey: KEY },
  });
  get.mockReset();
  get.mockResolvedValue({
    body: bodyOf("zip-bytes"),
    contentType: "application/zip",
  });
});

describe("the gates", () => {
  it("refuses a signed-out visitor and reads nothing (negative)", async () => {
    resolveViewer.mockResolvedValue({ kind: "unauthenticated" });
    const response = await call();
    expect(response.status).toBe(401);
    expect(readStatus).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses someone who is not in the organization (negative)", async () => {
    resolveViewer.mockResolvedValue({ kind: "not_found" });
    expect((await call()).status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses when two-factor enrolment is owed (negative)", async () => {
    resolveViewer.mockResolvedValue({ kind: "mfa_enroll" });
    expect((await call()).status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses when the organization requires SSO and the session is not one (negative)", async () => {
    resolveViewer.mockResolvedValue({ kind: "sso_required" });
    expect((await call()).status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  // A historical slug must be answered with the move, not spent. Reading on
  // with the stale slug resolves the viewer a second time, and that resolution
  // can only redirect through the optional `x-url` / `next-url` headers;
  // without one it lands on the organization root and the export id is gone,
  // so the person is handed a dashboard instead of their archive.
  it("redirects a renamed organization to the canonical download", async () => {
    resolveViewer.mockResolvedValue({
      kind: "redirect",
      org: "acme",
      ws: null,
    });
    const res = await call();
    expect(res.status).toBe(308);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe(
      `/acme/account/export/${EXPORT_ID}`,
    );
    // And nothing was read on the stale slug on the way past.
    expect(readStatus).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  // The capability matches the row on the principal, so someone else's id
  // refuses there. The route answers not_found either way, so a refusal never
  // says whether a stranger's export id is real.
  it("refuses another person's export without touching storage (negative)", async () => {
    readStatus.mockResolvedValue({ ok: false, reason: "not_found" });
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "not_found" });
    expect(get).not.toHaveBeenCalled();
  });

  // A read that failed is not an export that is missing. A 404 is permanent
  // and tells the person not to come back; the archive is still there.
  it("answers 503, not 404, when the read is unavailable (negative)", async () => {
    readStatus.mockResolvedValue({ ok: false, reason: "unavailable" });
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "unavailable" });
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses a bundle that is not written yet (negative)", async () => {
    readStatus.mockResolvedValue({
      ok: true,
      value: { ready: false, storageKey: null },
    });
    expect((await call()).status).toBe(409);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("the bytes", () => {
  it("streams the archive from the key the capability gave it", async () => {
    const response = await call();
    expect(get).toHaveBeenCalledWith(KEY);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="oxagen-export-${EXPORT_ID}.zip"`,
    );
    expect(await response.text()).toBe("zip-bytes");
  });

  // A data-subject export is never held by a shared cache.
  it("marks the response private and uncacheable", async () => {
    const response = await call();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("falls back to application/zip when the store reports no type", async () => {
    get.mockResolvedValue({ body: bodyOf("zip-bytes"), contentType: null });
    expect((await call()).headers.get("content-type")).toBe("application/zip");
  });
});
