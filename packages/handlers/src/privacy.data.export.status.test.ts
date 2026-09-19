import { describe, expect, it, vi, beforeEach } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import type { CapabilityContext } from "@oxagen/oxagen";

// The handler issues one read for a personal export:
//   select(...).from(exportRequests).where().limit(1)
// and a second for an organization one, the membership role behind
// `_org_membership.ts`. `selects` is therefore a queue rather than a single
// value, and every `where` is captured so the fences can be asserted rather
// than assumed: a status read that matched on the id alone would hand one
// person another's bundle, and one that skipped the role read would hand a
// demoted owner the whole organization's archive.
const mocks = vi.hoisted(() => ({
  selects: [] as unknown[][],
  wheres: [] as unknown[],
  // The export_data policy re-evaluation. Defaults to allow so every case
  // that is not about the mandate reads as it did before.
  checkIAM: vi.fn(),
}));

vi.mock("@oxagen/iam", () => ({ checkIAM: mocks.checkIAM }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const makeTx = () => ({
    select: () => ({
      from: () => ({
        where: (clause: unknown) => {
          mocks.wheres.push(clause);
          return {
            limit: () => Promise.resolve(mocks.selects.shift() ?? []),
          };
        },
      }),
    }),
  });
  return {
    ...real,
    withSystemDb: async (
      fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>,
    ) => fn(makeTx()),
  };
});

import {
  exportObjectKey,
  privacyDataExportStatusHandler,
} from "./privacy.data.export.status";

const EXPORT_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function ctx(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    orgId: ORG_ID,
    workspaceId: "33333333-3333-4333-8333-333333333333",
    userId: USER_ID,
    ...overrides,
  } as CapabilityContext;
}

/**
 * Every literal drizzle bound into the captured `where`, found by walking the
 * clause. Reading the values that reach Postgres rather than stringifying the
 * SQL, so the assertion is about what is actually matched.
 */
function boundValues(which = 0): unknown[] {
  const found: unknown[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "value" && typeof value === "string") found.push(value);
      else walk(value);
    }
  };
  walk(mocks.wheres[which]);
  return found;
}

/** Queue one row set per select the handler is expected to issue, in order. */
function queueSelects(...results: unknown[][]): void {
  mocks.selects.length = 0;
  for (const rows of results) mocks.selects.push(rows);
}

/** A personal export row, the shape the table hands back. */
function personalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPORT_ID,
    scope: "user",
    status: "ready",
    exportUrl: "privacy-exports/org/exp.zip",
    completedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.selects.length = 0;
  mocks.wheres.length = 0;
  mocks.checkIAM.mockReset();
  mocks.checkIAM.mockResolvedValue({
    result: { outcome: "allow", trace: [] },
    principal: null,
  });
});

describe("get_export_status", () => {
  it("refuses a machine principal", async () => {
    await expect(
      privacyDataExportStatusHandler(
        { exportId: EXPORT_ID },
        ctx({
          userId: null,
        } as Partial<CapabilityContext>),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => isHandlerError(error) && error.code === "forbidden",
    );
  });

  it("answers not_found for an id that is not this person's", async () => {
    queueSelects([]);
    await expect(
      privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()),
    ).rejects.toSatisfy(
      (error: unknown) => isHandlerError(error) && error.code === "not_found",
    );
    expect(mocks.wheres).toHaveLength(1);
  });

  // Three predicates, not one. IAM resolves this capability against
  // ctx.orgId, so a row matched on the id and the person alone stays readable
  // through a membership in another organisation after the caller has lost
  // the one that governed the export.
  it("matches the export id, the person AND the governed organisation", async () => {
    queueSelects([]);
    await privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()).catch(
      () => undefined,
    );
    expect(boundValues()).toEqual(
      expect.arrayContaining([EXPORT_ID, USER_ID, ORG_ID]),
    );
  });

  it("hands back the storage key once the bundle is ready", async () => {
    const completed = new Date("2026-09-18T22:00:00.000Z");
    queueSelects([personalRow({ completedAt: completed })]);
    const out = await privacyDataExportStatusHandler(
      { exportId: EXPORT_ID },
      ctx(),
    );
    expect(out).toEqual({
      exportId: EXPORT_ID,
      status: "ready",
      ready: true,
      storageKey: "privacy-exports/org/exp.zip",
      completedAt: "2026-09-18T22:00:00.000Z",
    });
  });

  it("offers no link while the bundle is still being written", async () => {
    queueSelects([personalRow({ status: "processing", exportUrl: null })]);
    const out = await privacyDataExportStatusHandler(
      { exportId: EXPORT_ID },
      ctx(),
    );
    expect(out).toEqual({
      exportId: EXPORT_ID,
      status: "processing",
      ready: false,
      storageKey: null,
      completedAt: null,
    });
  });

  // A url left on a row that later failed is not a bundle anyone should be
  // pointed at.
  it("offers no key for a failed export that still carries one", async () => {
    queueSelects([
      personalRow({
        status: "failed",
        exportUrl: "privacy-exports/org/half-written.zip",
      }),
    ]);
    const out = await privacyDataExportStatusHandler(
      { exportId: EXPORT_ID },
      ctx(),
    );
    expect(out.status).toBe("failed");
    expect(out.ready).toBe(false);
    expect(out.storageKey).toBeNull();
  });
});

// An organization export is everyone's data, and `export_data` gates queueing
// it on Owner or Admin. A queue is not a download: the ZIP lands minutes later,
// and the authority that started it can be gone by then. Without a second check
// the row still matches on id, person and org, so a demoted owner keeps the
// key to the whole organization's archive.
describe("reading an organization export", () => {
  /** The row, then the membership role the re-check reads. */
  function orgExport(role: string | null) {
    queueSelects(
      [personalRow({ scope: "org" })],
      role === null ? [] : [{ role }],
    );
  }

  it("refuses an owner who has since been demoted (negative)", async () => {
    orgExport("member");
    await expect(
      privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isHandlerError(error) &&
        error.code === "forbidden" &&
        error.reason === "org_export_requires_admin",
    );
  });

  it("refuses someone removed from the organization entirely (negative)", async () => {
    orgExport(null);
    await expect(
      privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()),
    ).rejects.toSatisfy(
      (error: unknown) => isHandlerError(error) && error.code === "forbidden",
    );
  });

  it("checks the membership against the governed org and this person", async () => {
    orgExport("owner");
    await privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx());
    expect(mocks.wheres).toHaveLength(2);
    expect(boundValues(1)).toEqual(expect.arrayContaining([ORG_ID, USER_ID]));
  });

  // The role is not the whole mandate. `org_users.role` cannot show an
  // explicit `export_data` deny grant, and this capability is a different one
  // with `defaultEffect: "allow"`, so the kernel's gate never reads that grant
  // either. Revoking the export mandate would otherwise stop new exports while
  // the finished archive stayed downloadable.
  it("refuses when the export mandate has been revoked (negative)", async () => {
    orgExport("owner");
    mocks.checkIAM.mockResolvedValue({
      result: { outcome: "deny", reason: "org_enforced_deny", trace: [] },
      principal: null,
    });
    await expect(
      privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isHandlerError(error) &&
        error.code === "forbidden" &&
        error.reason === "org_export_mandate_revoked",
    );
  });

  // Held for an approver is not held by this person: the archive is not
  // released while the decision is outstanding.
  it("refuses while the mandate is pending approval (negative)", async () => {
    orgExport("owner");
    mocks.checkIAM.mockResolvedValue({
      result: { outcome: "pending_approval", trace: [] },
      principal: null,
    });
    await expect(
      privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()),
    ).rejects.toSatisfy(
      (error: unknown) => isHandlerError(error) && error.code === "forbidden",
    );
  });

  // The question asked is the export's, not this read's: whether the person
  // may still receive the organization's data at all.
  it("asks the export_data policy, not its own", async () => {
    orgExport("owner");
    await privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx());
    expect(mocks.checkIAM).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "export_data" }),
    );
  });

  it("hands the key to an owner who still holds the role", async () => {
    orgExport("owner");
    const out = await privacyDataExportStatusHandler(
      { exportId: EXPORT_ID },
      ctx(),
    );
    expect(out.storageKey).toBe("privacy-exports/org/exp.zip");
  });

  it("hands the key to an admin as well", async () => {
    orgExport("admin");
    expect(
      (await privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()))
        .ready,
    ).toBe(true);
  });

  // org_users.role is written TitleCase by workspace.invite.send's mapRole()
  // and org.member.role.change, lowercase elsewhere, and the column's CHECK
  // accepts both. A case-sensitive compare would lock a legitimately promoted
  // admin out of their own organization's export.
  it("accepts the TitleCase spelling of the role", async () => {
    orgExport("Owner");
    expect(
      (await privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()))
        .ready,
    ).toBe(true);
  });

  // A personal export is the caller's own data and no role ever gated it, so
  // the extra read must not happen at all.
  it("reads no membership for a personal export", async () => {
    queueSelects([personalRow()]);
    await privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx());
    expect(mocks.wheres).toHaveLength(1);
  });

  // Nor does it re-evaluate the export mandate: no role ever gated a personal
  // export, so there is no mandate to have been revoked.
  it("re-evaluates no policy for a personal export (negative)", async () => {
    queueSelects([personalRow()]);
    await privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx());
    expect(mocks.checkIAM).not.toHaveBeenCalled();
  });
});

// Rows written before the key change hold `result.url`, and on Vercel Blob
// that is a full authenticated URL rather than a key. The driver returns
// `url: result.url` and `key: result.pathname`, which differ. An older ready
// export would otherwise read as ready and then fail at `storage().get()`.
describe("reading a key out of what the row holds", () => {
  it("passes a canonical key through untouched", () => {
    expect(exportObjectKey("privacy-exports/org-1/exp-1.zip")).toBe(
      "privacy-exports/org-1/exp-1.zip",
    );
  });

  it("takes the pathname out of an older stored blob URL", () => {
    expect(
      exportObjectKey(
        "https://abc123.blob.vercel-storage.com/privacy-exports/org-1/exp-1-Xy9.zip",
      ),
    ).toBe("privacy-exports/org-1/exp-1-Xy9.zip");
  });

  // The stored pathname carries the suffix Vercel added, so the recovered key
  // is the one the object was actually written under, not the input key.
  it("keeps a query string out of the key", () => {
    expect(
      exportObjectKey("https://x.example/privacy-exports/a.zip?token=secret"),
    ).toBe("privacy-exports/a.zip");
  });

  it("leaves something that is neither alone", () => {
    expect(exportObjectKey("s3://bucket/key.zip")).toBe("s3://bucket/key.zip");
  });

  it("hands the recovered key to the caller through the handler", async () => {
    queueSelects([
      personalRow({
        exportUrl:
          "https://abc123.blob.vercel-storage.com/privacy-exports/org-1/old.zip",
      }),
    ]);
    const out = await privacyDataExportStatusHandler(
      { exportId: EXPORT_ID },
      ctx(),
    );
    expect(out.storageKey).toBe("privacy-exports/org-1/old.zip");
  });
});
