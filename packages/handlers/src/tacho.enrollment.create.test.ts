import { generateKeyPairSync } from "node:crypto";
import type { CapabilityContext } from "@oxagen/oxagen";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  emitSecurityEvent: vi.fn(),
  resolveActorOrgRole: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...original, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));
vi.mock("./lib/api-key-authz", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/api-key-authz")>();
  return { ...original, resolveActorOrgRole: mocks.resolveActorOrgRole };
});
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { verifyBundle } from "./lib/tacho-bundle-signing";
import { signTachoEnrollment } from "./lib/tacho-enrollment-signing";
import { clearSteeringCacheForTests } from "./lib/tacho-steering";
import {
  deviceKeyFingerprint,
  resolveAllowedEndpoints,
} from "./lib/tacho-host-enroll";
import {
  agentSlugFor,
  tachoEnrollmentCreateHandler,
} from "./tacho.enrollment.create";

const CONTEXT: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "00000000-0000-0000-0000-0000000000aa",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};
const INPUT = {
  hostname: "Mac-Studio.local",
  osUser: "dev",
  platform: "darwin" as const,
  devicePublicKey: `ed25519:${Buffer.alloc(32, 7).toString("base64")}`,
  harnesses: ["claude-code" as const],
  claudeVersion: "2.1.263",
  managed: false,
  validityDays: 30,
};
const PEM = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

let inserted: Array<{ table: string; values: Record<string, unknown> }> = [];
/** The API key a bearer request presented, as the operator lookup reads it. */
let keyRow: Record<string, unknown> | undefined;

function happyDb(clash = false): void {
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // The host insert asks `information_schema` whether the gateway column
        // exists before naming it in RETURNING. "Applied" is the state these
        // cases are about.
        execute: async () => [{ "?column?": 1 }],
        query: {
          apiKeys: { findFirst: async () => keyRow },
          organizations: { findFirst: async () => ({ namespace: "acme" }) },
          workspaces: { findFirst: async () => ({ namespace: "core" }) },
          tachoHosts: {
            findFirst: async () => (clash ? { id: "existing" } : undefined),
          },
          authorizationDenyGenerations: { findMany: async () => [] },
          retentionPolicyVersions: { findFirst: async () => undefined },
          // No row: the observed-only policy every host had before
          // workspace.tacho_session_policy existed, which is what
          // these cases assert the bundle carries.
          tachoSessionPolicy: { findFirst: async () => undefined },
        },
        // The steering read: a workspace with an empty ledger and no records,
        // so the first bundle carries no `context.system`.
        select: () => ({
          from: () => ({
            where: async () => [{ ledger: 0, steering: 0 }],
            leftJoin: () => ({ where: async () => [] }),
          }),
        }),
        insert: (table: unknown) => ({
          values: (values: Record<string, unknown>) => ({
            returning: async () => {
              const name =
                Object.getOwnPropertySymbols(table as object)
                  .map((s) => (table as Record<symbol, string>)[s])
                  .find((v) => typeof v === "string") ?? "?";
              inserted.push({ table: name, values });
              return name === "api_keys"
                ? [{ id: "key-uuid", publicId: "aky_pub" }]
                : [{ ...values, id: "host-uuid", bundleVersionServed: null }];
            },
          }),
        }),
      }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSteeringCacheForTests();
  inserted = [];
  mocks.resolveActorOrgRole.mockResolvedValue("Owner");
  vi.stubEnv("TACHO_ENROLLMENT_SIGNING_SECRET", "test-secret");
  vi.stubEnv("TACHO_BUNDLE_SIGNING_PRIVATE_KEY", PEM.replace(/\n/g, "\\n"));
  vi.stubEnv(
    "TACHO_INGEST_ENDPOINTS",
    "https://api.example.test/v1/tacho/, http://plain.example.test/v1/tacho",
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("create_tacho_enrollment", () => {
  it("mints the key, the host, the signed enrollment, and a verifiable bundle", async () => {
    happyDb();
    const output = await tachoEnrollmentCreateHandler(INPUT, CONTEXT);
    expect(output.hostEnrollmentId).toMatch(/^tch_[a-z0-9]{22}$/);
    expect(output.agentKey).toBe("acme.core.cc-mac-studio");
    expect(output.apiKey).toMatch(/^ox_/);
    expect(output.enrollment.claims).toMatchObject({
      host_enrollment_id: output.hostEnrollmentId,
      agent_key: "acme.core.cc-mac-studio",
      ingest_endpoint: "https://api.example.test/v1/tacho/events",
      bundle_endpoint: "https://api.example.test/v1/tacho/bundle",
      commands_endpoint: "https://api.example.test/v1/tacho/commands",
      credential_env: "TACHO_HOST_API_KEY",
      harnesses: ["claude-code"],
    });
    expect(output.enrollment.signature_hex).toBe(
      signTachoEnrollment(output.enrollment.claims, "test-secret"),
    );
    expect(output.enrollment.verification_secret_env).toBe(
      "TACHO_ENROLLMENT_SIGNING_SECRET",
    );
    expect(verifyBundle(output.policyBundle, output.bundlePublicKeyPem)).toBe(
      true,
    );
    expect(output.policyBundle).toMatchObject({
      host_status: "active",
      mode: "observe",
      host_enrollment_id: output.hostEnrollmentId,
    });

    const key = inserted.find((row) => row.table === "api_keys");
    expect(key?.values["scope"]).toEqual({
      purpose: "tacho_host_v1",
      host_enrollment_id: output.hostEnrollmentId,
    });
    const host = inserted.find((row) => row.table === "hosts");
    expect(host?.values).toMatchObject({
      publicId: output.hostEnrollmentId,
      apiKeyId: "key-uuid",
      hostname: "Mac-Studio.local",
      platform: "darwin",
      status: "active",
      mode: "observe",
      claudeVersionAtEnroll: "2.1.263",
    });
    expect(host?.values["hostnameDigest"]).toMatch(/^sha256:/);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "api_key.created",
        capability: "create_tacho_enrollment",
      }),
    );
  });

  it("records what the enrolling client says its bundle parser understands", async () => {
    // Enrollment hands back the host's first policy bundle, parsed by a
    // `.strict()` schema, so a gated field must not be signed into it unless
    // the client named the field. A client that says nothing gets an empty
    // list, which is the same answer as cannot parse it.
    happyDb();
    await tachoEnrollmentCreateHandler(
      { ...INPUT, bundleFeatures: ["gateway_tools"] },
      CONTEXT,
    );
    expect(inserted.find((row) => row.table === "hosts")?.values).toMatchObject(
      { bundleFeatures: ["gateway_tools"] },
    );

    inserted = [];
    happyDb();
    await tachoEnrollmentCreateHandler(INPUT, CONTEXT);
    expect(inserted.find((row) => row.table === "hosts")?.values).toMatchObject(
      { bundleFeatures: [] },
    );
  });

  it("suffixes the agent key when the hostname slug is taken", async () => {
    happyDb(true);
    const output = await tachoEnrollmentCreateHandler(INPUT, CONTEXT);
    expect(output.agentKey).toMatch(/^acme\.core\.cc-mac-studio-[a-z0-9]{4}$/);
  });

  it("refuses without a user, without the role, or without signing material", async () => {
    happyDb();
    await expect(
      tachoEnrollmentCreateHandler(INPUT, { ...CONTEXT, userId: null }),
    ).rejects.toThrow(/Unauthorized/);
    mocks.resolveActorOrgRole.mockResolvedValueOnce("Member");
    await expect(tachoEnrollmentCreateHandler(INPUT, CONTEXT)).rejects.toThrow(
      /Owners and Admins/,
    );
    vi.stubEnv("TACHO_ENROLLMENT_SIGNING_SECRET", "");
    await expect(tachoEnrollmentCreateHandler(INPUT, CONTEXT)).rejects.toThrow(
      /TACHO_ENROLLMENT_SIGNING_SECRET/,
    );
    vi.stubEnv("TACHO_ENROLLMENT_SIGNING_SECRET", "s");
    vi.stubEnv("TACHO_BUNDLE_SIGNING_PRIVATE_KEY", "");
    await expect(tachoEnrollmentCreateHandler(INPUT, CONTEXT)).rejects.toThrow(
      /TACHO_BUNDLE_SIGNING_PRIVATE_KEY/,
    );
    expect(inserted).toEqual([]);
  });

  it("acts for the person who minted an `oxagen login` key, never for a machine's key", async () => {
    // The desktop app and `tacho enroll` hold only the key `oxagen login`
    // minted, and the API hands a handler no user for any bearer key.
    happyDb();
    const creator = "00000000-0000-0000-0000-0000000000bb";
    const keyContext = { ...CONTEXT, userId: null, apiKeyId: "key-cli" };
    keyRow = {
      scope: {},
      createdById: creator,
      stellaTelemetryEnrollmentId: null,
    };
    const output = await tachoEnrollmentCreateHandler(INPUT, keyContext);
    expect(output.apiKey).toMatch(/^ox_/);
    expect(mocks.resolveActorOrgRole).toHaveBeenCalledWith(
      CONTEXT.orgId,
      creator,
    );
    const host = inserted.find((row) => row.table === "hosts");
    expect(host?.values["createdById"]).toBe(creator);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: creator }),
    );

    inserted = [];
    keyRow = {
      scope: {
        purpose: "tacho_host_v1",
        host_enrollment_id: output.hostEnrollmentId,
      },
      createdById: creator,
      stellaTelemetryEnrollmentId: null,
    };
    await expect(
      tachoEnrollmentCreateHandler(INPUT, keyContext),
    ).rejects.toThrow(/does not act for a person/);
    expect(inserted).toEqual([]);
  });

  it("derives slugs, fingerprints, and HTTPS-only endpoints", () => {
    expect(agentSlugFor("Mac-Studio.local")).toBe("cc-mac-studio");
    expect(agentSlugFor("a-very-long-hostname-that-goes-on")).toBe(
      "cc-a-very-long-hos",
    );
    expect(agentSlugFor("!!!")).toBe("cc-host");
    expect(deviceKeyFingerprint(INPUT.devicePublicKey)).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(resolveAllowedEndpoints()).toEqual([
      "https://api.example.test/v1/tacho",
    ]);
    vi.stubEnv("TACHO_INGEST_ENDPOINTS", "");
    expect(resolveAllowedEndpoints()).toEqual([
      "https://api.oxagen.sh/v1/tacho",
    ]);
  });
});
