/**
 * route.test.ts — regression tests for
 * GET /api/v1/conversations/[conversationId]/assets/archive.
 *
 * Covers the auth chain the "Download all" ZIP depends on (session → existing
 * conversation → org membership → capability-listed files) and the streamed
 * ZIP response contract: application/zip, attachment disposition named after
 * the conversation title, and the archive helper receiving exactly the
 * capability-listed entries with the session principal.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  select: vi.fn(),
  invoke: vi.fn(),
  archive: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (
      fn: (tx: Record<string, unknown>) => Promise<unknown>,
    ) => fn({ select: mocks.select } as unknown as Record<string, unknown>),
  };
});

vi.mock("@oxagen/oxagen", () => ({ invoke: mocks.invoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/handlers", () => ({ archiveGeneratedAssets: mocks.archive }));

import { GET } from "./route";

/** Drizzle-shaped select builder resolving to `rows`. */
function selectBuilder(rows: unknown[]): unknown {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  return { from };
}

const CONV = {
  orgId: "org-1",
  workspaceId: "ws-1",
  title: "Q3 Revenue Deep-Dive!",
};
const MEMBER = { id: "member-row" };
const FILES = [
  { publicId: "gen_1", name: "chart.png", mimeType: "image/png" },
  { publicId: "gen_2", name: "notes.md", mimeType: "text/markdown" },
];

function zipStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x50, 0x4b, 0x05, 0x06]));
      controller.close();
    },
  });
}

function request(conversationId = "cnv_abc") {
  return GET(new Request("https://app.oxagen.sh/x"), {
    params: Promise.resolve({ conversationId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.select
    .mockReturnValueOnce(selectBuilder([CONV]))
    .mockReturnValueOnce(selectBuilder([MEMBER]));
  mocks.invoke.mockResolvedValue({ files: FILES });
  mocks.archive.mockReturnValue(zipStream());
});

describe("GET /api/v1/conversations/[id]/assets/archive", () => {
  it("401s without a session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await request();
    expect(res.status).toBe(401);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("404s when the conversation does not exist", async () => {
    mocks.select.mockReset().mockReturnValueOnce(selectBuilder([]));
    const res = await request();
    expect(res.status).toBe(404);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("404s when the caller is not a member of the conversation's org (IDOR guard)", async () => {
    mocks.select
      .mockReset()
      .mockReturnValueOnce(selectBuilder([CONV]))
      .mockReturnValueOnce(selectBuilder([]));
    const res = await request();
    expect(res.status).toBe(404);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("404s when the conversation has no files", async () => {
    mocks.invoke.mockResolvedValue({ files: [] });
    const res = await request();
    expect(res.status).toBe(404);
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("streams a ZIP of the capability-listed files with the session principal", async () => {
    const res = await request();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    // Attachment named after the slugified conversation title.
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="q3-revenue-deep-dive-files.zip"',
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    // The file list came from the metered capability, not raw SQL.
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_conversation_files",
      expect.objectContaining({ conversationId: "cnv_abc", limit: 200 }),
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
      { surface: "api" },
    );
    // The archive helper got exactly the listed entries + the app principal,
    // so each file's access policy is re-enforced server-side.
    expect(mocks.archive).toHaveBeenCalledWith(
      FILES.map((f) => ({
        publicId: f.publicId,
        name: f.name,
        mimeType: f.mimeType,
      })),
      expect.objectContaining({ userId: "user-1", surface: "app" }),
    );

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  it("falls back to the conversation id for an untitled conversation's filename", async () => {
    mocks.select
      .mockReset()
      .mockReturnValueOnce(selectBuilder([{ ...CONV, title: null }]))
      .mockReturnValueOnce(selectBuilder([MEMBER]));
    const res = await request("cnv_untitled1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="cnv_untitled1-files.zip"',
    );
  });

  it("maps an out-of-scope capability error to 404", async () => {
    mocks.invoke.mockRejectedValue(new Error("conversation not found"));
    const res = await request();
    expect(res.status).toBe(404);
  });
});
