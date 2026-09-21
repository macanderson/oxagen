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
}));

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

// The second revocation path the handler observes: an explicit `deny` written
// against `export_data` itself. The handler asks the IAM resolver about it
// through `fetchAuthz`, and the resolver runs here for real. Only the Postgres
// read is replaced, so these tests pin the decision rather than a stub of it.
//
// The default is an organisation with nothing configured (no principal, no
// roles, no grants), which is what every test but the revocation ones wants:
// the resolver finds nothing explicit and the role check stays the only gate.
/**
 * The audit write this guard makes, and whether a failure of it was reported.
 * A decision made outside the kernel whose row is lost without a word leaves
 * the governance record saying the question was never asked.
 */
const auditEmission = vi.hoisted(() => ({
  next: () => Promise.resolve(),
  reported: [] as { capability: string; err: unknown; where?: string }[],
}));

const authz = vi.hoisted(() => ({
  value: {
    principal: null as unknown,
    grants: [] as unknown[],
    roles: [] as unknown[],
    roleGrants: [] as unknown[],
    policies: [] as unknown[],
  },
  calls: [] as { capability: string; orgId: string; userId: string | null }[],
  /** The workspace each policy read was asked in, in order. */
  workspaces: [] as string[],
  /** When set, the configured policy applies in this workspace only. */
  onlyIn: null as string | null,
}));

vi.mock("@oxagen/iam", () => ({
  emitAudit: () => auditEmission.next(),
  reportAuditEmissionFailure: (
    capability: string,
    _ctx: unknown,
    err: unknown,
    where?: string,
  ) => {
    auditEmission.reported.push({ capability, err, where });
  },
  fetchAuthz: (args: {
    capability: string;
    orgId: string;
    userId: string | null;
    workspaceId: string;
  }) => {
    authz.calls.push({
      capability: args.capability,
      orgId: args.orgId,
      userId: args.userId,
    });
    authz.workspaces.push(args.workspaceId);
    if (authz.onlyIn !== null && args.workspaceId !== authz.onlyIn) {
      return Promise.resolve({
        principal: null,
        grants: [],
        roles: [],
        roleGrants: [],
        policies: [],
      });
    }
    return Promise.resolve(authz.value);
  },
}));

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
    // Queued in the workspace `ctx()` calls from, unless a case says otherwise.
    workspaceId: "33333333-3333-4333-8333-333333333333",
    ...overrides,
  };
}

const PRINCIPAL_ID = "44444444-4444-4444-8444-444444444444";
const ROLE_ID = "55555555-5555-4555-8555-555555555555";

/**
 * The organisation as it looks after an administrator writes an explicit deny
 * against `export_data` for a role the caller holds: every role intact, one
 * `iam.role_grants` row with `effect: "deny"`. This is the state
 * `orgMembershipRole` cannot observe: `org_users.role` still says owner.
 */
function denyExportData(effect: "deny" | "require_approval" = "deny"): void {
  authz.value = {
    principal: {
      id: PRINCIPAL_ID,
      kind: "human",
      orgId: ORG_ID,
      workspaceId: null,
    },
    grants: [],
    roles: [
      {
        id: ROLE_ID,
        name: "Owner",
        scopeKind: "org",
        orgId: ORG_ID,
        principalIds: [PRINCIPAL_ID],
        isSystemDefault: true,
      },
    ],
    roleGrants: [{ roleId: ROLE_ID, capabilityId: "export_data", effect }],
    policies: [],
  };
}

beforeEach(() => {
  auditEmission.next = () => Promise.resolve();
  auditEmission.reported.length = 0;
  mocks.selects.length = 0;
  mocks.wheres.length = 0;
  authz.calls.length = 0;
  authz.workspaces.length = 0;
  authz.onlyIn = null;
  authz.value = {
    principal: null,
    grants: [],
    roles: [],
    roleGrants: [],
    policies: [],
  };
});

describe("get_export_status", () => {
  it.each(["api", "mcp"] as const)(
    "refuses a machine principal on %s",
    async (surface) => {
      await expect(
        privacyDataExportStatusHandler(
          { exportId: EXPORT_ID },
          ctx({
            userId: null,
            surface,
          } as Partial<CapabilityContext>),
        ),
      ).rejects.toSatisfy(
        (error: unknown) => isHandlerError(error) && error.code === "forbidden",
      );
    },
  );

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

// The role is not the only way the mandate goes away. An administrator can
// leave every role alone and write an explicit `deny` against `export_data`,
// and `org_users.role` cannot see that row, so without the policy re-check
// the completed organization archive stays downloadable after access was
// revoked. `get_export_status` is `defaultEffect: "allow"` and the download
// routes invoke it rather than `export_data`, so nothing else catches it.
describe("an export_data deny written after the archive was queued", () => {
  /** A ready org export whose caller is still, on paper, the owner. */
  function readyOrgExportForAnOwner(): void {
    queueSelects([personalRow({ scope: "org" })], [{ role: "owner" }]);
  }

  // The guard's audit row is the only record that this question was asked
  // outside the kernel and how it was answered. `checkIAM` escalates a lost
  // row to ClickHouse `error_events` and the alert webhook; discarding it here
  // would let an `export_data` decision leave the governance record with
  // nothing to say it happened.
  it("reports a failed audit write rather than discarding it", async () => {
    auditEmission.next = () => Promise.reject(new Error("clickhouse down"));
    readyOrgExportForAnOwner();
    const answered = await privacyDataExportStatusHandler(
      { exportId: EXPORT_ID },
      ctx(),
    );

    // Non-blocking: a decision that was made is not unmade by a failed log
    // write, so the read still answers.
    expect(answered.exportId).toBe(EXPORT_ID);
    await vi.waitFor(() => {
      expect(auditEmission.reported).toHaveLength(1);
    });
    expect(auditEmission.reported[0]?.capability).toBe("export_data");
    expect(auditEmission.reported[0]?.where).toBe(
      "handlers:capabilityRevocation",
    );
  });

  it("refuses the read rather than returning the storage key", async () => {
    readyOrgExportForAnOwner();
    denyExportData();
    await expect(
      privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isHandlerError(error) &&
        error.code === "forbidden" &&
        error.reason === "org_export_not_permitted",
    );
  });

  // The question asked is `export_data`'s, in the organisation that governed
  // the export, for the person reading it. Asking about `get_export_status`
  // instead would miss the deny entirely: no rule is keyed to that name.
  it("asks about export_data in the governed organisation", async () => {
    readyOrgExportForAnOwner();
    denyExportData();
    await privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()).catch(
      () => undefined,
    );
    expect(authz.calls).toEqual([
      { capability: "export_data", orgId: ORG_ID, userId: USER_ID },
    ]);
  });

  // No plan tier is read on this path, by construction: the kernel's own gate
  // answers `tier_gate → allow` before any policy is read on every tier but
  // enterprise, so a check that consulted the tier would pass its test and
  // change nothing for the organisations most customers are on.
  it("refuses without consulting the plan tier", async () => {
    readyOrgExportForAnOwner();
    denyExportData();
    await expect(
      privacyDataExportStatusHandler(
        { exportId: EXPORT_ID },
        ctx({ planTier: "free" } as Partial<CapabilityContext>),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => isHandlerError(error) && error.code === "forbidden",
    );
  });

  // `require_approval` has nothing to satisfy on the API and app surfaces,
  // because the approval step is read only by the agent tool wrapper, so it is
  // refused rather than treated as a grant.
  it("refuses an explicit require_approval as well", async () => {
    readyOrgExportForAnOwner();
    denyExportData("require_approval");
    await expect(
      privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()),
    ).rejects.toSatisfy(
      (error: unknown) => isHandlerError(error) && error.code === "forbidden",
    );
  });

  // A deny on another capability is not this one. Keyed matching, not a
  // substring or a prefix.
  it("is unmoved by a deny on a different capability", async () => {
    readyOrgExportForAnOwner();
    denyExportData();
    authz.value = {
      ...authz.value,
      roleGrants: [
        { roleId: ROLE_ID, capabilityId: "erase_data", effect: "deny" },
      ],
    };
    const out = await privacyDataExportStatusHandler(
      { exportId: EXPORT_ID },
      ctx(),
    );
    expect(out.storageKey).toBe("privacy-exports/org/exp.zip");
  });

  // A personal export is the caller's own data. No role gated it and no
  // organization policy governs it, so the deny must not reach it and the
  // resolver must not even be asked.
  it("still hands a person their own export while the org deny stands", async () => {
    queueSelects([personalRow()]);
    denyExportData();
    const out = await privacyDataExportStatusHandler(
      { exportId: EXPORT_ID },
      ctx(),
    );
    expect(out.storageKey).toBe("privacy-exports/org/exp.zip");
    expect(authz.calls).toEqual([]);
  });

  // The role check runs first and is unchanged: a demoted owner is refused on
  // the role, whatever the policy says.
  it("still refuses a demoted owner when nothing is denied", async () => {
    queueSelects([personalRow({ scope: "org" })], [{ role: "member" }]);
    await expect(
      privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isHandlerError(error) &&
        error.code === "forbidden" &&
        error.reason === "org_export_requires_admin",
    );
    expect(authz.calls).toEqual([]);
  });

  // A caller in no workspace still gets an answer: the scope the IAM read needs
  // is entered with the org-only sentinel (ADR-068), and an org rule binds a
  // call that names no workspace.
  it("observes the deny for a caller who names no workspace", async () => {
    readyOrgExportForAnOwner();
    denyExportData();
    await expect(
      privacyDataExportStatusHandler(
        { exportId: EXPORT_ID },
        ctx({ workspaceId: undefined }),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => isHandlerError(error) && error.code === "forbidden",
    );
  });

  // An organisation that has configured nothing is not an organisation that
  // denied something. The resolver's "nothing matched" fallback must read as
  // "nothing revoked it", or every unprovisioned org loses its archive.
  it("hands the key over when no rule names export_data", async () => {
    readyOrgExportForAnOwner();
    const out = await privacyDataExportStatusHandler(
      { exportId: EXPORT_ID },
      ctx(),
    );
    expect(out.storageKey).toBe("privacy-exports/org/exp.zip");
    expect(authz.calls).toHaveLength(1);
  });
});

// The download route is mounted under any workspace slug, so the policy of the
// workspace a download arrives through is not the policy that governed the
// export. A deny written in the queuing workspace has to hold wherever the
// archive is asked for from.
describe("an export_data deny in the workspace that queued the export", () => {
  const QUEUED_IN = "66666666-6666-4666-8666-666666666666";
  const CALLING_FROM = "33333333-3333-4333-8333-333333333333";

  function readyOrgExportQueuedIn(workspaceId: string | null): void {
    queueSelects(
      [personalRow({ scope: "org", workspaceId })],
      [{ role: "owner" }],
    );
  }

  it("refuses a download through another workspace (negative)", async () => {
    readyOrgExportQueuedIn(QUEUED_IN);
    denyExportData();
    authz.onlyIn = QUEUED_IN;
    await expect(
      privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isHandlerError(error) &&
        error.code === "forbidden" &&
        error.reason === "org_export_not_permitted",
    );
    expect(authz.workspaces).toEqual([QUEUED_IN]);
  });

  it("still refuses on a deny in the calling workspace alone", async () => {
    readyOrgExportQueuedIn(QUEUED_IN);
    denyExportData();
    authz.onlyIn = CALLING_FROM;
    await expect(
      privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()),
    ).rejects.toSatisfy(
      (error: unknown) => isHandlerError(error) && error.code === "forbidden",
    );
    expect(authz.workspaces).toEqual([QUEUED_IN, CALLING_FROM]);
  });

  it("hands the key over when neither workspace denies it", async () => {
    readyOrgExportQueuedIn(QUEUED_IN);
    const out = await privacyDataExportStatusHandler(
      { exportId: EXPORT_ID },
      ctx(),
    );
    expect(out.storageKey).toBe("privacy-exports/org/exp.zip");
    expect(authz.workspaces).toEqual([QUEUED_IN, CALLING_FROM]);
  });

  it("asks once when the download comes through the queuing workspace", async () => {
    readyOrgExportQueuedIn(CALLING_FROM);
    await privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx());
    expect(authz.workspaces).toEqual([CALLING_FROM]);
  });

  // A queue made in no workspace records the org-only sentinel, so its
  // recheck asks at organization scope as well as in the calling one.
  it("asks at organization scope for an export queued in no workspace", async () => {
    const ORG_ONLY = "00000000-0000-0000-0000-000000000000";
    readyOrgExportQueuedIn(ORG_ONLY);
    await privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx());
    expect(authz.workspaces).toEqual([ORG_ONLY, CALLING_FROM]);
  });

  // A row written before the column existed has no recorded scope. A deny in
  // the workspace that governed it cannot be checked, and the archive holds
  // the whole organization's data, so it is refused, not released on a check
  // that may be asking the wrong workspace.
  it("refuses an organization export whose scope was never recorded (negative)", async () => {
    readyOrgExportQueuedIn(null);
    await expect(
      privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isHandlerError(error) &&
        error.code === "forbidden" &&
        error.reason === "org_export_scope_unknown",
    );
    expect(authz.workspaces).toEqual([]);
  });

  // The refusal is for organization archives only. A personal export is the
  // caller's own data and no workspace policy ever gated it.
  it("still hands over a personal export with no recorded scope", async () => {
    queueSelects([personalRow({ workspaceId: null })]);
    const out = await privacyDataExportStatusHandler(
      { exportId: EXPORT_ID },
      ctx(),
    );
    expect(out.storageKey).toBe("privacy-exports/org/exp.zip");
  });
});
