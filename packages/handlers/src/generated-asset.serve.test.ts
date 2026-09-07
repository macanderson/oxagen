/**
 * Unit tests for serveGeneratedAsset (generated-asset.serve.ts).
 *
 * Mirrors file.serve.test.ts but covers the per-asset access policy
 * (public / org / user) on top of the org-membership / org-match checks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AssetServePrincipal } from "./generated-asset.serve";

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  storageGet: vi.fn(),
  insertEvents: vi.fn(),
}));

function makeSelectBuilder(rows: unknown[]): unknown {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  return { from };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => ({ select: mocks.dbSelect }),
    // withSystemDb passthrough: the handler uses withSystemDb for asset row
    // lookup and org-membership check. Forward fn to a fake tx with
    // the same select mock so existing test chains apply.
    withSystemDb: async (
      fn: (tx: Record<string, unknown>) => Promise<unknown>,
    ) => fn({ select: mocks.dbSelect } as unknown as Record<string, unknown>),
  };
});

vi.mock("@oxagen/storage", async () => {
  class StorageNotFoundError extends Error {
    readonly notFound = true as const;
    constructor(key: string) {
      super(`Storage object not found: ${key}`);
      this.name = "StorageNotFoundError";
    }
  }
  return { storage: () => ({ get: mocks.storageGet }), StorageNotFoundError };
});

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return { ...real, insertEvents: mocks.insertEvents };
});

vi.mock("node:crypto", () => ({
  randomUUID: () => "00000000-0000-0000-0000-000000000001",
}));

const {
  serveGeneratedAsset,
  GeneratedAssetNotFoundError,
  GeneratedAssetForbiddenError,
} = await import("./generated-asset.serve");
const { StorageNotFoundError } = await import("@oxagen/storage");

function asset(overrides: Record<string, unknown> = {}) {
  return {
    id: "internal-uuid",
    publicId: "gen_T1",
    orgId: "org-aaa",
    workspaceId: "ws-bbb",
    userId: "user-owner",
    accessPolicy: "org",
    status: "ready",
    deletedAt: null,
    storageKey: "generated/images/org-aaa/abc.png",
    storageUrl: "https://store/abc.png",
    mimeType: "image/png",
    sizeBytes: 2048n,
    // The serve handler derives the Content-Disposition filename from these.
    kind: "image",
    prompt: "A test image",
    metadata: null,
    ...overrides,
  };
}

const STREAM_BODY = new ReadableStream<Uint8Array>();

function apiPrincipal(
  o: Partial<AssetServePrincipal> = {},
): AssetServePrincipal {
  return { orgId: "org-aaa", workspaceId: "ws-bbb", surface: "api", ...o };
}
function appPrincipal(
  o: Partial<AssetServePrincipal> = {},
): AssetServePrincipal {
  return { userId: "user-owner", surface: "app", ...o };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storageGet.mockResolvedValue({
    body: STREAM_BODY,
    contentType: "image/png",
    sizeBytes: 2048,
  });
  mocks.insertEvents.mockResolvedValue(undefined);
});

describe("serveGeneratedAsset", () => {
  it("404s when the asset row is absent", async () => {
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([]));
    await expect(
      serveGeneratedAsset("gen_X", apiPrincipal()),
    ).rejects.toBeInstanceOf(GeneratedAssetNotFoundError);
    expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  // Regression — a WRONG-TYPE id (an agent public id `agt_…` mistakenly used as
  // an asset id) has no matching `generated_assets` row, so it must surface as a
  // clean GeneratedAssetNotFoundError (→ 404 at the route), never an unhandled
  // error. The route would otherwise have surfaced the API's raw
  // "Organization not found" JSON to the consuming <img>/<a>.
  it("404s (clean NotFound) for an agent-prefixed id with no asset row", async () => {
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([]));
    await expect(
      serveGeneratedAsset("agt_ccbpt7mffmqwbtbg1z1sfg", appPrincipal()),
    ).rejects.toBeInstanceOf(GeneratedAssetNotFoundError);
    expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  it("404s when the asset is not ready (pending render)", async () => {
    mocks.dbSelect.mockReturnValueOnce(
      makeSelectBuilder([asset({ status: "pending" })]),
    );
    await expect(
      serveGeneratedAsset("gen_T1", apiPrincipal()),
    ).rejects.toBeInstanceOf(GeneratedAssetNotFoundError);
  });

  it("404s when the asset is soft-deleted", async () => {
    mocks.dbSelect.mockReturnValueOnce(
      makeSelectBuilder([asset({ deletedAt: new Date() })]),
    );
    await expect(
      serveGeneratedAsset("gen_T1", appPrincipal()),
    ).rejects.toBeInstanceOf(GeneratedAssetNotFoundError);
  });

  // ── public policy ──
  it("public — serves to a request with no identity", async () => {
    mocks.dbSelect.mockReturnValueOnce(
      makeSelectBuilder([asset({ accessPolicy: "public" })]),
    );
    const result = await serveGeneratedAsset("gen_T1", { surface: "app" });
    expect(result.body).toBe(STREAM_BODY);
    // Inline disposition + a human-readable slug filename (never the gen_ id).
    expect(result.contentDisposition).toBe(
      `inline; filename="a-test-image.png"; filename*=UTF-8''a-test-image.png`,
    );
  });

  // ── org policy ──
  it("org — app member serves; non-member 404s", async () => {
    mocks.dbSelect
      .mockReturnValueOnce(makeSelectBuilder([asset()])) // asset
      .mockReturnValueOnce(makeSelectBuilder([{ id: "oru-1" }])); // membership
    const ok = await serveGeneratedAsset(
      "gen_T1",
      appPrincipal({ userId: "member-1" }),
    );
    expect(ok.body).toBe(STREAM_BODY);

    mocks.dbSelect.mockReset();
    mocks.dbSelect
      .mockReturnValueOnce(makeSelectBuilder([asset()]))
      .mockReturnValueOnce(makeSelectBuilder([])); // not a member
    await expect(
      serveGeneratedAsset("gen_T1", appPrincipal({ userId: "stranger" })),
    ).rejects.toBeInstanceOf(GeneratedAssetNotFoundError);
  });

  it("org — api org match serves; org mismatch 404s", async () => {
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([asset()]));
    const ok = await serveGeneratedAsset("gen_T1", apiPrincipal());
    expect(ok.body).toBe(STREAM_BODY);

    mocks.dbSelect.mockReset();
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([asset()]));
    await expect(
      serveGeneratedAsset("gen_T1", apiPrincipal({ orgId: "org-WRONG" })),
    ).rejects.toBeInstanceOf(GeneratedAssetNotFoundError);
  });

  // ── user policy ──
  it("user — only the creator may read (app)", async () => {
    mocks.dbSelect.mockReturnValueOnce(
      makeSelectBuilder([asset({ accessPolicy: "user" })]),
    );
    const ok = await serveGeneratedAsset(
      "gen_T1",
      appPrincipal({ userId: "user-owner" }),
    );
    expect(ok.body).toBe(STREAM_BODY);

    mocks.dbSelect.mockReset();
    mocks.dbSelect.mockReturnValueOnce(
      makeSelectBuilder([asset({ accessPolicy: "user" })]),
    );
    await expect(
      serveGeneratedAsset("gen_T1", appPrincipal({ userId: "someone-else" })),
    ).rejects.toBeInstanceOf(GeneratedAssetNotFoundError);
  });

  it("user — an api key (no user identity) cannot read a user-private asset", async () => {
    mocks.dbSelect.mockReturnValueOnce(
      makeSelectBuilder([asset({ accessPolicy: "user" })]),
    );
    await expect(
      serveGeneratedAsset("gen_T1", apiPrincipal()),
    ).rejects.toBeInstanceOf(GeneratedAssetNotFoundError);
  });

  // ── no identity on a non-public asset ──
  it("forbidden when no identity is present for a non-public asset", async () => {
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([asset()]));
    await expect(
      serveGeneratedAsset("gen_T1", { surface: "api" }),
    ).rejects.toBeInstanceOf(GeneratedAssetForbiddenError);
  });

  // ── storage + telemetry ──
  it("maps a missing storage object to 404", async () => {
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([asset()]));
    mocks.storageGet.mockRejectedValue(new StorageNotFoundError("k"));
    await expect(
      serveGeneratedAsset("gen_T1", apiPrincipal()),
    ).rejects.toBeInstanceOf(GeneratedAssetNotFoundError);
  });

  it("video assets serve inline with a slug filename", async () => {
    mocks.dbSelect.mockReturnValueOnce(
      makeSelectBuilder([
        asset({ kind: "video", mimeType: "video/mp4", prompt: "Ocean waves" }),
      ]),
    );
    const result = await serveGeneratedAsset("gen_T1", apiPrincipal());
    expect(result.contentDisposition).toBe(
      `inline; filename="ocean-waves.mp4"; filename*=UTF-8''ocean-waves.mp4`,
    );
    expect(result.mimeType).toBe("video/mp4");
  });

  it("markdown serves INLINE so clicking the name displays it (.md slug)", async () => {
    mocks.dbSelect.mockReturnValueOnce(
      makeSelectBuilder([
        asset({
          kind: "document",
          mimeType: "text/markdown",
          prompt: "Generate markdown: USS Nautilus Polar Crossing",
        }),
      ]),
    );
    const result = await serveGeneratedAsset("gen_T1", apiPrincipal());
    expect(result.contentDisposition).toBe(
      `inline; filename="uss-nautilus-polar-crossing.md"; filename*=UTF-8''uss-nautilus-polar-crossing.md`,
    );
  });

  it("office documents serve as a downloadable ATTACHMENT (.docx slug)", async () => {
    mocks.dbSelect.mockReturnValueOnce(
      makeSelectBuilder([
        asset({
          kind: "document",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          prompt: "Onboarding checklist",
        }),
      ]),
    );
    const result = await serveGeneratedAsset("gen_T1", apiPrincipal());
    expect(result.contentDisposition).toBe(
      `attachment; filename="onboarding-checklist.docx"; filename*=UTF-8''onboarding-checklist.docx`,
    );
  });

  it("prefers a clean metadata.displayName for the filename", async () => {
    mocks.dbSelect.mockReturnValueOnce(
      makeSelectBuilder([
        asset({
          kind: "document",
          mimeType: "text/markdown",
          prompt: "Generate markdown: ignore me",
          metadata: { displayName: "Polar Crossing Report" },
        }),
      ]),
    );
    const result = await serveGeneratedAsset("gen_T1", apiPrincipal());
    expect(result.contentDisposition).toContain(
      `filename="polar-crossing-report.md"`,
    );
  });

  it("telemetry failure does not break the response", async () => {
    mocks.dbSelect.mockReturnValueOnce(makeSelectBuilder([asset()]));
    mocks.insertEvents.mockRejectedValue(new Error("clickhouse down"));
    const result = await serveGeneratedAsset("gen_T1", apiPrincipal());
    expect(result.body).toBe(STREAM_BODY);
  });
});
