// enroll_host refuses a token whose agent was deleted or retired after the
// token was issued. onboarding.pg.test.ts covers the full enrollment against
// Postgres. Here the host mint is stubbed, so the test can show the refusal
// mints no host and leaves the token unused. The last block runs the real
// mint against a fake transaction, to show the first bundle carries the
// workspace's steering records (#2592).
import { createHash, generateKeyPairSync } from "node:crypto";
import type { CapabilityContext } from "@oxagen/oxagen";
import { BUNDLE_FEATURE_STEERING_MANIFEST } from "@oxagen/recorder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  mintHostEnrollment: vi.fn(),
  enrollmentDocument: vi.fn(),
  requireEnrollmentSigning: vi.fn(),
  emitSecurityEvent: vi.fn(),
  resolveHostMandate: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...original,
    withSystemDb: mocks.withSystemDb,
    withTenantDb: mocks.withTenantDb,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("./lib/tacho-host-enroll", () => ({
  mintHostEnrollment: mocks.mintHostEnrollment,
  enrollmentDocument: mocks.enrollmentDocument,
  requireEnrollmentSigning: mocks.requireEnrollmentSigning,
}));
// The mandate is not what these cases are about, and resolving it for an
// agent with a principal reads the agent's grants and toolbelt. The steering
// read and the bundle signing stay real.
vi.mock("./lib/tacho-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/tacho-host")>()),
  resolveHostMandate: mocks.resolveHostMandate,
}));
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { verifyBundle } from "./lib/tacho-bundle-signing";
import {
  clearSteeringCacheForTests,
  type SteeringRow,
} from "./lib/tacho-steering";
import { tachoHostEnrollHandler } from "./tacho.host.enroll";

const CONTEXT: CapabilityContext = {
  orgId: "",
  workspaceId: "",
  userId: null,
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const INPUT = {
  token: `oxe_1time_${"A".repeat(26)}`,
  hostname: "Mac-Studio.local",
  osUser: "dev",
  platform: "darwin" as const,
  devicePublicKey: `ed25519:${Buffer.alloc(32, 7).toString("base64")}`,
  harnesses: ["claude-code" as const],
  managed: false,
  validityDays: 30,
} as Parameters<typeof tachoHostEnrollHandler>[0];

const TOKEN = {
  id: "token-uuid",
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  issuedToUserId: "00000000-0000-0000-0000-0000000000aa",
  expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  usedAt: null,
};

const AGENT = {
  id: "agent-uuid",
  publicId: "agt_1",
  slug: "reviewer",
  status: "active",
  principalId: "prn-agent",
  orgNamespace: "acme",
  orgSlug: "acme",
  workspaceNamespace: "core",
  workspaceSlug: "core",
};

/** Updates the tenant transaction issued. The only one marks the token used. */
let tenantUpdates = 0;

/** The token read, outside any tenant scope, answers TOKEN. */
function systemDb(): void {
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const read = {
        from: () => read,
        where: () => read,
        limit: async () => [TOKEN],
      };
      return fn({
        select: () => read,
        update: () => ({ set: () => ({ where: async () => [] }) }),
      });
    },
  );
}

/**
 * The token read answers TOKEN. Inside the tenant transaction the reads
 * answer, in order: the locked token row, the agent (or none), and no
 * existing host.
 */
function db(agent: Record<string, unknown> | undefined): void {
  systemDb();
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const answers: unknown[][] = [
        [{ usedAt: null, agentId: "agent-uuid" }],
        agent ? [agent] : [],
        [],
      ];
      const next = async () => answers.shift() ?? [];
      const read = {
        from: () => read,
        innerJoin: () => read,
        where: () => read,
        limit: next,
        for: next,
      };
      return fn({
        select: () => read,
        update: () => {
          tenantUpdates += 1;
          return { set: () => ({ where: async () => [] }) };
        },
      });
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantUpdates = 0;
  mocks.requireEnrollmentSigning.mockReturnValue({ secret: "s" });
  mocks.mintHostEnrollment.mockResolvedValue({
    host: { id: "host-uuid", agentKey: "acme.core.reviewer" },
    hostEnrollmentId: "tch_1",
  });
  mocks.enrollmentDocument.mockReturnValue({ hostEnrollmentId: "tch_1" });
});

describe("enroll_host", () => {
  it("enrolls a host for a live agent and marks the token used", async () => {
    db(AGENT);
    const out = await tachoHostEnrollHandler(INPUT, CONTEXT);
    expect(out.agentId).toBe("agt_1");
    expect(mocks.mintHostEnrollment).toHaveBeenCalledTimes(1);
    expect(tenantUpdates).toBe(1);
  });

  it("refuses a token whose agent was retired (archived) after it was issued", async () => {
    db({ ...AGENT, status: "archived" });
    await expect(tachoHostEnrollHandler(INPUT, CONTEXT)).rejects.toMatchObject({
      code: "conflict",
      reason: "agent_retired",
      message: 'Agent "reviewer" is retired',
    });
    expect(mocks.mintHostEnrollment).not.toHaveBeenCalled();
    // The token keeps `used_at` null: nothing marked it used.
    expect(tenantUpdates).toBe(0);
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("refuses a token whose agent was deleted, with the same reason", async () => {
    db(undefined);
    await expect(tachoHostEnrollHandler(INPUT, CONTEXT)).rejects.toMatchObject({
      code: "conflict",
      reason: "agent_retired",
      message: "The agent this token was issued for no longer exists",
    });
    expect(mocks.mintHostEnrollment).not.toHaveBeenCalled();
    expect(tenantUpdates).toBe(0);
  });
});

const PEM = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

/**
 * Three active records, each joined to its pinned version as the steering
 * read selects them: one `must`, one `should`, and one `info`. The assembler
 * delivers `must` and `should`, and cuts `info` for its tier.
 */
const RECORDS: SteeringRow[] = [
  {
    slug: "no-force-push",
    activatedAt: "2026-09-02T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    versionKind: "constraint",
    versionForce: "must",
    versionConstraintEffect: "forbid",
    versionStatement: "Never force-push to the production branch.",
    recordKind: "constraint",
    recordForce: "must",
    recordConstraintEffect: "forbid",
    recordStatement: "Never force-push to the production branch.",
  },
  {
    slug: "pr-for-main",
    activatedAt: "2026-09-03T00:00:00.000Z",
    createdAt: "2026-09-03T00:00:00.000Z",
    versionKind: "rule",
    versionForce: "should",
    versionConstraintEffect: null,
    versionStatement: "Open a pull request for every change to main.",
    recordKind: "rule",
    recordForce: "should",
    recordConstraintEffect: null,
    recordStatement: "Open a pull request for every change to main.",
  },
  {
    slug: "deploy-region",
    activatedAt: "2026-09-04T00:00:00.000Z",
    createdAt: "2026-09-04T00:00:00.000Z",
    versionKind: "fact",
    versionForce: "info",
    versionConstraintEffect: null,
    versionStatement: "Production runs in us-east-1.",
    recordKind: "fact",
    recordForce: "info",
    recordConstraintEffect: null,
    recordStatement: "Production runs in us-east-1.",
  },
];
const MUST_LINE =
  "- Never force-push to the production branch. (constraint, forbid; no-force-push)";
const SHOULD_LINE =
  "- Open a pull request for every change to main. (rule; pr-for-main)";

/** `sha256:<hex>` of the text's UTF-8 bytes, the form `text_digest` takes. */
function sha256Digest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function tableName(table: unknown): string {
  for (const symbol of Object.getOwnPropertySymbols(table as object)) {
    if (symbol.description === "drizzle:Name")
      return (table as Record<symbol, string>)[symbol] ?? "?";
  }
  return "?";
}

/**
 * A tenant transaction the real mint runs against. Each read answers by the
 * table it names: the unused token, the agent (the handler's join and the
 * mint's runtime read take one row, which names a runtime so no runtime is
 * created), no existing host, and the steering read. The steering read is the
 * ledger count over `context_promotions`, awaited straight off `.where()`,
 * and `records` joined to their pinned versions. The fake counts one
 * promotion per record, since a merge appends one.
 */
function mintDb(records: SteeringRow[]): void {
  systemDb();
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const answer = (table: unknown): unknown[] => {
        switch (tableName(table)) {
          case "enrollment_tokens":
            return [{ usedAt: null, agentId: "agent-uuid" }];
          case "agents":
            return [
              { ...AGENT, runtimeId: "runtime-uuid", activeVersionId: null },
            ];
          case "context_promotions":
            return [{ ledger: records.length, steering: records.length }];
          default:
            return [];
        }
      };
      return fn({
        // The column probes (the host's gateway column, the version
        // classification columns) find the migrated schema.
        execute: async () => [{ "?column?": 1 }],
        query: {
          authorizationDenyGenerations: { findMany: async () => [] },
          retentionPolicyVersions: { findFirst: async () => undefined },
        },
        select: () => ({
          from: (table: unknown) => {
            const rows = answer(table);
            const read: {
              innerJoin: () => typeof read;
              where: () => typeof read;
              limit: () => Promise<unknown[]>;
              for: () => Promise<unknown[]>;
              leftJoin: () => { where: () => Promise<unknown[]> };
              then: (
                resolve: (rows: unknown[]) => unknown,
                reject?: (err: unknown) => unknown,
              ) => Promise<unknown>;
            } = {
              innerJoin: () => read,
              where: () => read,
              limit: async () => rows,
              for: async () => rows,
              leftJoin: () => ({ where: async () => records }),
              then: (resolve, reject) =>
                Promise.resolve(rows).then(resolve, reject),
            };
            return read;
          },
        }),
        insert: (table: unknown) => ({
          values: (values: Record<string, unknown>) => ({
            returning: async () =>
              tableName(table) === "api_keys"
                ? [{ id: "key-uuid", publicId: "aky_pub" }]
                : [{ ...values, id: "host-uuid", bundleVersionServed: null }],
          }),
        }),
        update: () => ({ set: () => ({ where: async () => [] }) }),
      });
    },
  );
}

// The witness for #2592 on the token path (ADR-091): the host runs on the
// bundle signed here until its first poll, so a merged record has to be in
// this one too.
describe("enroll_host's first bundle", () => {
  beforeEach(async () => {
    clearSteeringCacheForTests();
    const actual = await vi.importActual<
      typeof import("./lib/tacho-host-enroll")
    >("./lib/tacho-host-enroll");
    mocks.requireEnrollmentSigning.mockImplementation(
      actual.requireEnrollmentSigning,
    );
    mocks.mintHostEnrollment.mockImplementation(actual.mintHostEnrollment);
    mocks.enrollmentDocument.mockImplementation(actual.enrollmentDocument);
    mocks.resolveHostMandate.mockResolvedValue({
      permissions: { allow: [], deny: [], ask: [] },
      budget: { mode: "observed" },
    });
    vi.stubEnv("TACHO_ENROLLMENT_SIGNING_SECRET", "test-secret");
    vi.stubEnv("TACHO_BUNDLE_SIGNING_PRIVATE_KEY", PEM.replace(/\n/g, "\\n"));
    vi.stubEnv("TACHO_INGEST_ENDPOINTS", "https://api.example.test/v1/tacho");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("signs the workspace's must and should records into context.system, with a manifest whose text_digest is its digest", async () => {
    mintDb(RECORDS);
    const out = await tachoHostEnrollHandler(
      { ...INPUT, bundleFeatures: [BUNDLE_FEATURE_STEERING_MANIFEST] },
      CONTEXT,
    );
    expect(verifyBundle(out.policyBundle, out.bundlePublicKeyPem)).toBe(true);
    const { system, manifest } = out.policyBundle.context;
    expect(system).toEqual(expect.any(String));
    expect(system).toContain(MUST_LINE);
    expect(system).toContain(SHOULD_LINE);
    expect(system).not.toContain("us-east-1");
    expect(manifest?.text_digest).toBe(sha256Digest(system ?? ""));
    expect(manifest).toMatchObject({ included: 2, cut: 1 });
    expect(
      manifest?.items.find((item) => item.id === "deploy-region"),
    ).toMatchObject({ outcome: "cut", reason: "tier" });
  });

  it("signs a null context.system when the workspace has no steering records", async () => {
    mintDb([]);
    const out = await tachoHostEnrollHandler(
      { ...INPUT, bundleFeatures: [BUNDLE_FEATURE_STEERING_MANIFEST] },
      CONTEXT,
    );
    expect(out.policyBundle.context.system).toBeNull();
    expect(out.policyBundle.context.manifest).toMatchObject({
      included: 0,
      text_digest: null,
    });
  });
});
