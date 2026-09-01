/**
 * The enrollment minter is the ONLY writer of the server-owned enrollment
 * columns, so most of these tests are about what it refuses.
 */
import type { CapabilityContext } from "@oxagen/oxagen";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  emitSecurityEvent: vi.fn(),
  resolveActorOrgRole: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  return { ...original, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));

vi.mock("./lib/api-key-authz", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/api-key-authz")>();
  return { ...original, resolveActorOrgRole: mocks.resolveActorOrgRole };
});

vi.mock("./logger", () => ({
  logger: {
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    info: mocks.loggerInfo,
    debug: vi.fn(),
  },
}));

import { telemetryStellaEnrollHandler } from "./telemetry.stella.enroll";

const CONTEXT: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "00000000-0000-0000-0000-0000000000aa",
  apiKeyId: null,
  requestId: "req_enroll",
  surface: "api",
  messageId: null,
};

const ENDPOINT = "https://api.oxagen.sh/v1/telemetry/stella/operational";

const INPUT = {
  name: "acme prod fleet",
  endpoint: ENDPOINT,
  credentialEnv: "STELLA_ENTERPRISE_TELEMETRY_TOKEN",
  modelCatalog: [{ provider: "anthropic", model: "anthropic/claude-fable-5" }],
  validityDays: 90,
};

/** Enterprise subscription present, and the insert returns a row. */
function happyDb(): void {
  mocks.withTenantDb.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      query: {
        subscriptions: {
          findFirst: async () => ({
            id: "sub_1",
            status: "active",
            plan: { tier: "enterprise" },
          }),
        },
      },
      insert: () => ({
        values: (row: Record<string, unknown>) => ({
          returning: async () => {
            inserted = row;
            return [{ publicId: "aky_pub_1" }];
          },
        }),
      }),
    }),
  );
}

let inserted: Record<string, unknown> | undefined;

beforeEach(() => {
  inserted = undefined;
  vi.clearAllMocks();
  process.env["STELLA_ENROLLMENT_SIGNING_SECRET"] = "test-signing-secret";
  delete process.env["STELLA_TELEMETRY_INGEST_ENDPOINTS"];
  mocks.resolveActorOrgRole.mockResolvedValue("Owner");
  happyDb();
});

afterEach(() => {
  delete process.env["STELLA_ENROLLMENT_SIGNING_SECRET"];
  delete process.env["STELLA_TELEMETRY_INGEST_ENDPOINTS"];
});

describe("telemetry.stella.enroll — the happy path", () => {
  it("writes the scope and the server-owned columns together", async () => {
    // The paired-NULL CHECK means one without the other is a constraint
    // violation; more importantly, the ingest handler cross-checks the two.
    const out = await telemetryStellaEnrollHandler(INPUT, CONTEXT);
    expect(inserted?.stellaTelemetryEnrollmentId).toBe(out.enrollmentId);
    expect(inserted?.stellaTelemetryEnrolledAt).toBeInstanceOf(Date);
    expect(inserted?.scope).toEqual({
      purpose: "stella_operational_telemetry_v1",
      enrollment_id: out.enrollmentId,
    });
  });

  it("returns a signed managed-settings document Stella can verify", async () => {
    const out = await telemetryStellaEnrollHandler(INPUT, CONTEXT);
    const settings = out.managedSettings as Record<string, unknown>;
    expect(settings.host_data_isolation).toBe("process_free");
    expect(settings.allowed_endpoints).toEqual([ENDPOINT]);
    const enrollment = settings.enrollment as Record<string, unknown>;
    expect(enrollment.signature_hex).toMatch(/^[0-9a-f]{64}$/);
    const claims = enrollment.claims as Record<string, unknown>;
    expect(claims.organization_id).toBe(CONTEXT.orgId);
    expect(claims.workspace_id).toBe(CONTEXT.workspaceId);
    expect(claims.enrollment_id).toBe(out.enrollmentId);
  });

  it("mints operational rollups only — never the compliance-audit class", async () => {
    // A separate decision with its own review; an enrollment minted here must
    // not quietly carry it.
    const out = await telemetryStellaEnrollHandler(INPUT, CONTEXT);
    const claims = (
      (out.managedSettings as Record<string, unknown>).enrollment as Record<
        string,
        unknown
      >
    ).claims as Record<string, unknown>;
    expect(claims.event_classes).toEqual(["execution_rollup"]);
  });

  it("returns the raw key once and records the audit event", async () => {
    const out = await telemetryStellaEnrollHandler(INPUT, CONTEXT);
    expect(out.apiKey).toMatch(/^ox_/);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "create_stella_enrollment" }),
    );
  });
});

describe("telemetry.stella.enroll — what it refuses", () => {
  it("refuses an endpoint this deployment does not serve", async () => {
    // Otherwise an operator could mint a SIGNED document pointing a fleet of
    // installs at a third party — the signature would verify and the
    // telemetry would leave.
    await expect(
      telemetryStellaEnrollHandler(
        { ...INPUT, endpoint: "https://evil.test/collect" },
        CONTEXT,
      ),
    ).rejects.toThrow(/endpoint must be one of/);
    expect(inserted).toBeUndefined();
  });

  it("refuses a plaintext endpoint even when it is configured", async () => {
    process.env["STELLA_TELEMETRY_INGEST_ENDPOINTS"] =
      "http://insecure.test/v1/x";
    await expect(
      telemetryStellaEnrollHandler(
        { ...INPUT, endpoint: "http://insecure.test/v1/x" },
        CONTEXT,
      ),
    ).rejects.toThrow(/endpoint must be one of/);
  });

  it("refuses a non-Owner/Admin actor", async () => {
    mocks.resolveActorOrgRole.mockResolvedValue("Member");
    await expect(telemetryStellaEnrollHandler(INPUT, CONTEXT)).rejects.toThrow(
      /only org Owners and Admins/,
    );
    expect(inserted).toBeUndefined();
  });

  it("refuses when the org is not on the Enterprise tier", async () => {
    // The ingest handler demands this too; minting a key whose batches would
    // be refused on arrival is the worse failure.
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) =>
        fn({
          query: {
            subscriptions: {
              findFirst: async () => ({
                id: "sub_1",
                status: "active",
                plan: { tier: "pro" },
              }),
            },
          },
        }),
    );
    await expect(telemetryStellaEnrollHandler(INPUT, CONTEXT)).rejects.toThrow(
      /Enterprise subscription required/,
    );
  });

  it("refuses to mint when signing is not configured", async () => {
    // An unsigned document is rejected by the install; discovering that at
    // the install is far worse than discovering it here.
    delete process.env["STELLA_ENROLLMENT_SIGNING_SECRET"];
    await expect(telemetryStellaEnrollHandler(INPUT, CONTEXT)).rejects.toThrow(
      /signing is not configured/,
    );
    expect(inserted).toBeUndefined();
  });

  it("refuses without an authenticated user or a workspace", async () => {
    await expect(
      telemetryStellaEnrollHandler(INPUT, { ...CONTEXT, userId: null }),
    ).rejects.toThrow(/no authenticated user/);
    // Empty string, not null: `CheckedContext.workspaceId` is typed
    // non-nullable, and "" is what the kernel's unscoped path actually carries.
    await expect(
      telemetryStellaEnrollHandler(INPUT, { ...CONTEXT, workspaceId: "" }),
    ).rejects.toThrow(/workspaceId is required/);
  });
});
