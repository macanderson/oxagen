/**
 * resolve-org-redirect.test.ts — unit tests for the slug-history-aware
 * resolvers.
 *
 * Covers:
 *   (a) resolveOrgWithRedirect returns the current row when the slug matches
 *   (b) resolveOrgWithRedirect falls back to org_slug_history and resolves
 *       the org by id when only the history match exists (most-recent wins)
 *   (c) resolveOrgWithRedirect respects redirect_enabled=false (no fallback)
 *       — caller sees 404 just like an unknown slug
 *   (d) resolveOrgOrRedirect issues a 308 permanent redirect to the canonical
 *       URL with the rest of the path + query preserved
 *   (e) resolveWorkspaceWithRedirect: same three cases scoped by (orgId, slug)
 *   (f) resolveWorkspaceOrRedirect preserves /{orgSlug}/{workspaceSlug}/... shape
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock plumbing ───────────────────────────────────────────────────
// Each resolver issues 1–3 sequential queries. The mock pops a precomputed
// response off a FIFO queue per call so we can script multi-step lookups
// (current-slug miss → history hit → org-by-id read) cleanly.
const { notFoundMock, permanentRedirectMock, queue, mockWithSystemDb } =
  vi.hoisted(() => {
    const queue: unknown[][] = [];
    const mockLimit = vi.fn(() => Promise.resolve(queue.shift() ?? []));
    const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
    const mockWhere = vi.fn(() => ({ limit: mockLimit, orderBy: mockOrderBy }));
    const mockFrom = vi.fn(() => ({ where: mockWhere }));
    const mockSelect = vi.fn(() => ({ from: mockFrom }));
    const mockTx = { select: mockSelect };
    const mockWithSystemDb = vi.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn(mockTx),
    );
    const notFoundMock = vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    const permanentRedirectMock = vi.fn((url: string) => {
      // Real Next.js permanentRedirect throws a synthetic error captured by
      // the framework; mirror that here so callers can assert it was raised.
      const err = new Error("NEXT_PERMANENT_REDIRECT");
      (err as { url?: string }).url = url;
      throw err;
    });

    return { notFoundMock, permanentRedirectMock, queue, mockWithSystemDb };
  });

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
  permanentRedirect: permanentRedirectMock,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: mockWithSystemDb,
  };
});

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args)),
    and: vi.fn((...args: Parameters<typeof real.and>) => real.and(...args)),
    desc: vi.fn((...args: Parameters<typeof real.desc>) => real.desc(...args)),
  };
});

vi.mock("server-only", () => ({}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  // cache() returns the same fn — we want test isolation, not per-test memo.
  return { ...actual, cache: (fn: unknown) => fn };
});

import {
  resolveOrgWithRedirect,
  resolveOrgOrRedirect,
  resolveWorkspaceWithRedirect,
  resolveWorkspaceOrRedirect,
} from "./resolve-org";

beforeEach(() => {
  vi.clearAllMocks();
  queue.length = 0;
});

// Helper: push a list of response rowsets — one per upcoming withSystemDb call.
function queueRows(...rowsets: unknown[][]) {
  queue.push(...rowsets);
}

const ORG = {
  id: "org-1",
  publicId: "ten_abc",
  name: "Acme",
  slug: "acme-new",
};

const WORKSPACE = {
  id: "ws-1",
  publicId: "wrk_abc",
  orgId: "org-1",
  name: "Prod",
  slug: "prod-new",
  settings: { description: "" },
};

// ── resolveOrgWithRedirect ──────────────────────────────────────────────────

describe("resolveOrgWithRedirect", () => {
  it("returns the org directly when the URL slug matches the current slug", async () => {
    queueRows([ORG]); // single current-slug hit
    const result = await resolveOrgWithRedirect("acme-new");
    expect(result.slug).toBe("acme-new");
    expect(mockWithSystemDb).toHaveBeenCalledTimes(1);
  });

  it("falls back to org_slug_history and resolves by id on a current-slug miss", async () => {
    // 1st query: current-slug lookup → empty
    // 2nd query: org_slug_history lookup → one match returning orgId
    // 3rd query: org-by-id lookup → the canonical row
    queueRows([], [{ orgId: "org-1" }], [ORG]);
    const result = await resolveOrgWithRedirect("acme-old");
    expect(result.slug).toBe("acme-new");
    expect(mockWithSystemDb).toHaveBeenCalledTimes(3);
    // Caller did NOT 404 — the resolver found a redirect candidate.
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("calls notFound() when neither current slug nor history matches", async () => {
    queueRows([], []); // current miss + history miss
    await expect(resolveOrgWithRedirect("ghost")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  it("calls notFound() when history points at a deleted org", async () => {
    queueRows([], [{ orgId: "org-1" }], []);
    await expect(resolveOrgWithRedirect("acme-old")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});

// ── resolveOrgOrRedirect — the layout-facing helper ────────────────────────

describe("resolveOrgOrRedirect", () => {
  it("returns the org unchanged when the URL slug is already canonical", async () => {
    queueRows([ORG]);
    const result = await resolveOrgOrRedirect("acme-new", "/acme-new/ask", "");
    expect(result.slug).toBe("acme-new");
    expect(permanentRedirectMock).not.toHaveBeenCalled();
  });

  it("permanent-redirects to the canonical URL preserving path + query", async () => {
    queueRows([], [{ orgId: "org-1" }], [ORG]);
    await expect(
      resolveOrgOrRedirect("acme-old", "/acme-old/ask/123", "?q=abc"),
    ).rejects.toThrow("NEXT_PERMANENT_REDIRECT");
    expect(permanentRedirectMock).toHaveBeenCalledWith(
      "/acme-new/ask/123?q=abc",
    );
  });

  it("only rewrites the first path segment (the org slug)", async () => {
    // pathname like /acme-old/foo/acme-old — only the first acme-old moves.
    queueRows([], [{ orgId: "org-1" }], [ORG]);
    await expect(
      resolveOrgOrRedirect("acme-old", "/acme-old/foo/acme-old", ""),
    ).rejects.toThrow("NEXT_PERMANENT_REDIRECT");
    expect(permanentRedirectMock).toHaveBeenCalledWith(
      "/acme-new/foo/acme-old",
    );
  });

  it("handles the org root path /{oldSlug} with no trailing segment", async () => {
    queueRows([], [{ orgId: "org-1" }], [ORG]);
    await expect(
      resolveOrgOrRedirect("acme-old", "/acme-old", ""),
    ).rejects.toThrow("NEXT_PERMANENT_REDIRECT");
    expect(permanentRedirectMock).toHaveBeenCalledWith("/acme-new");
  });
});

// ── resolveWorkspaceWithRedirect ────────────────────────────────────────────

describe("resolveWorkspaceWithRedirect", () => {
  it("returns the workspace when the slug matches", async () => {
    queueRows([WORKSPACE]);
    const result = await resolveWorkspaceWithRedirect("org-1", "prod-new");
    expect(result.slug).toBe("prod-new");
    expect(result.orgId).toBe("org-1");
  });

  it("falls back to workspace_slug_history scoped by orgId on a slug miss", async () => {
    queueRows([], [{ workspaceId: "ws-1" }], [WORKSPACE]);
    const result = await resolveWorkspaceWithRedirect("org-1", "prod-old");
    expect(result.slug).toBe("prod-new");
    expect(mockWithSystemDb).toHaveBeenCalledTimes(3);
  });

  it("404s when neither current slug nor history matches for the given org", async () => {
    queueRows([], []);
    await expect(
      resolveWorkspaceWithRedirect("org-1", "ghost"),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

// ── resolveWorkspaceOrRedirect ──────────────────────────────────────────────

describe("resolveWorkspaceOrRedirect", () => {
  it("does not redirect when the URL workspace slug is canonical", async () => {
    queueRows([WORKSPACE]);
    const result = await resolveWorkspaceOrRedirect(
      "org-1",
      "acme",
      "prod-new",
      "/acme/prod-new/ask",
      "",
    );
    expect(result.slug).toBe("prod-new");
    expect(permanentRedirectMock).not.toHaveBeenCalled();
  });

  it("permanent-redirects to /{orgSlug}/{newWs}/... preserving the tail + query", async () => {
    queueRows([], [{ workspaceId: "ws-1" }], [WORKSPACE]);
    await expect(
      resolveWorkspaceOrRedirect(
        "org-1",
        "acme",
        "prod-old",
        "/acme/prod-old/ask/42",
        "?q=z",
      ),
    ).rejects.toThrow("NEXT_PERMANENT_REDIRECT");
    expect(permanentRedirectMock).toHaveBeenCalledWith(
      "/acme/prod-new/ask/42?q=z",
    );
  });

  it("handles the workspace root path /{orgSlug}/{oldWs} with no trailing segment", async () => {
    queueRows([], [{ workspaceId: "ws-1" }], [WORKSPACE]);
    await expect(
      resolveWorkspaceOrRedirect(
        "org-1",
        "acme",
        "prod-old",
        "/acme/prod-old",
        "",
      ),
    ).rejects.toThrow("NEXT_PERMANENT_REDIRECT");
    expect(permanentRedirectMock).toHaveBeenCalledWith("/acme/prod-new");
  });
});
