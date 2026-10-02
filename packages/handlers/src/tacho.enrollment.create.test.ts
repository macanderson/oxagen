import { createHash, generateKeyPairSync } from "node:crypto";
import type { CapabilityContext } from "@oxagen/oxagen";
import { BUNDLE_FEATURE_STEERING_MANIFEST } from "@oxagen/recorder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  emitSecurityEvent: vi.fn(),
  resolveActorOrgRole: vi.fn(),
  openAgentFile: vi.fn(),
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
// The agent file PR (#5149) opens on the steering host. These cases assert
// what enrollment hands it; steering-repo/agent-file.test.ts covers the PR.
vi.mock("./steering-repo/agent-file", () => ({
  openAgentFilePrQuietly: mocks.openAgentFile,
  AGENT_FILE_PULL_REQUEST: {
    reasonPrefix: "agent_file",
    noun: "agent file steering PR",
    refusal: () => null,
    proposalKind: "agent_file",
  },
}));

import { verifyBundle } from "./lib/tacho-bundle-signing";
import { signTachoEnrollment } from "./lib/tacho-enrollment-signing";
import {
  clearSteeringCacheForTests,
  type SteeringRow,
} from "./lib/tacho-steering";
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

let inserted: Array<{ table: string; values: Record<string, unknown> }> = [];
/** The API key a bearer request presented, as the operator lookup reads it. */
let keyRow: Record<string, unknown> | undefined;

/** The enrolling member's public id the operator read answers, or none. */
let operatorPublicId: string | null = null;

function happyDb(clash = false, records: SteeringRow[] = []): void {
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
          // The host bundle reads containment from the host's runtime
          // (ADR-204). The runtime these cases create does not require it,
          // so the bundle carries no `containment`.
          agents: { findFirst: async () => ({ runtimeId: null }) },
          runtimes: {
            findFirst: async () => ({ containmentRequired: false }),
          },
        },
        // The steering read: the ledger count over `context_promotions`
        // (awaited straight off `.where()`) and `records` joined to their
        // pinned versions (`.leftJoin().where()`). The fake counts one
        // promotion per record, since a merge appends one. With no records
        // the first bundle carries no `context.system`. The runtime reads
        // (ADR-198) go on to `.orderBy()` / `.limit()` and find no runtime,
        // so the operator path creates the one the hostname names.
        select: (columns?: Record<string, unknown>) => ({
          from: () => {
            // The operator read (#5149) selects the member's public id alone.
            const operatorRead =
              columns !== undefined &&
              Object.keys(columns).length === 1 &&
              "publicId" in columns;
            const chain: {
              where: () => typeof chain;
              innerJoin: () => typeof chain;
              orderBy: () => typeof chain;
              limit: () => Promise<unknown[]>;
              leftJoin: () => { where: () => Promise<unknown[]> };
              then: (
                resolve: (rows: unknown[]) => unknown,
                reject?: (err: unknown) => unknown,
              ) => Promise<unknown>;
            } = {
              where: () => chain,
              innerJoin: () => chain,
              orderBy: () => chain,
              limit: async () =>
                operatorRead && operatorPublicId !== null
                  ? [{ publicId: operatorPublicId }]
                  : [],
              leftJoin: () => ({ where: async () => records }),
              then: (resolve, reject) =>
                Promise.resolve([
                  { ledger: records.length, steering: records.length },
                ]).then(resolve, reject),
            };
            return chain;
          },
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
                : name === "runtimes"
                  ? [{ ...values, id: "runtime-uuid", publicId: "rtm_pub" }]
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
  operatorPublicId = null;
  mocks.openAgentFile.mockResolvedValue(null);
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

describe("create_tacho_enrollment: the agent file (#5149)", () => {
  it("proposes the runtime's agent file once the host is enrolled, naming the member who enrolled it", async () => {
    happyDb();
    operatorPublicId = "usr_01k5qk7d0000000000000000";

    const output = await tachoEnrollmentCreateHandler(INPUT, CONTEXT);

    expect(output.hostEnrollmentId).toMatch(/^tch_[a-z0-9]{22}$/);
    expect(mocks.openAgentFile).toHaveBeenCalledTimes(1);
    expect(mocks.openAgentFile).toHaveBeenCalledWith(
      expect.objectContaining({
        opener: expect.any(Object),
        host: expect.any(Function),
        proposals: expect.any(Object),
      }),
      {
        scope: { orgId: CONTEXT.orgId, workspaceId: CONTEXT.workspaceId },
        operator: {
          userId: CONTEXT.userId,
          publicId: "usr_01k5qk7d0000000000000000",
        },
        runtime: { slug: "mac-studio", name: "Mac-Studio.local" },
        hostname: "Mac-Studio.local",
        harnesses: ["claude-code"],
      },
    );
  });

  it("proposes nothing when the operator is not a member the read finds", async () => {
    happyDb();
    await tachoEnrollmentCreateHandler(INPUT, CONTEXT);
    expect(mocks.openAgentFile).not.toHaveBeenCalled();
  });

  it("still enrolls the host when proposing the agent file throws", async () => {
    happyDb();
    operatorPublicId = "usr_01k5qk7d0000000000000000";
    mocks.openAgentFile.mockRejectedValue(new Error("the steering host is down"));

    const output = await tachoEnrollmentCreateHandler(INPUT, CONTEXT);

    expect(output.apiKey).toMatch(/^ox_/);
    expect(output.gatewayApiKey).toBeDefined();
  });
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
    // No agent names a runtime, so the host binds the one its hostname names,
    // created with the slug rule every runtime slug follows (ADR-198).
    const runtime = inserted.find((row) => row.table === "runtimes");
    expect(runtime?.values).toMatchObject({
      name: "Mac-Studio.local",
      slug: "mac-studio",
    });
    expect(host?.values["runtimeId"]).toBe("runtime-uuid");
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

  // The witness for #2592 at enrollment (ADR-091): the host runs on the
  // bundle signed here until its first poll, so a merged record has to be in
  // this one too.
  it("signs the workspace's must and should records into the first bundle's context.system, and leaves the info record out", async () => {
    happyDb(false, RECORDS);
    const output = await tachoEnrollmentCreateHandler(INPUT, CONTEXT);
    expect(verifyBundle(output.policyBundle, output.bundlePublicKeyPem)).toBe(
      true,
    );
    const { system, manifest } = output.policyBundle.context;
    expect(system).toEqual(expect.any(String));
    expect(system).toContain(MUST_LINE);
    expect(system).toContain(SHOULD_LINE);
    expect(system).not.toContain("us-east-1");
    // This client advertised no manifest, and its parser is strict.
    expect(manifest).toBeUndefined();
  });

  it("signs a null context.system when the workspace has no steering records", async () => {
    happyDb();
    const output = await tachoEnrollmentCreateHandler(
      { ...INPUT, bundleFeatures: [BUNDLE_FEATURE_STEERING_MANIFEST] },
      CONTEXT,
    );
    expect(output.policyBundle.context.system).toBeNull();
    expect(output.policyBundle.context.manifest).toMatchObject({
      included: 0,
      text_digest: null,
    });
  });

  it("signs a manifest whose text_digest is the digest of context.system, for a host that reads the manifest", async () => {
    happyDb(false, RECORDS);
    const output = await tachoEnrollmentCreateHandler(
      { ...INPUT, bundleFeatures: [BUNDLE_FEATURE_STEERING_MANIFEST] },
      CONTEXT,
    );
    const { system, manifest } = output.policyBundle.context;
    expect(system).toEqual(expect.any(String));
    expect(manifest?.text_digest).toBe(sha256Digest(system ?? ""));
    expect(manifest).toMatchObject({ included: 2, cut: 1 });
    expect(
      manifest?.items.find((item) => item.id === "deploy-region"),
    ).toMatchObject({ outcome: "cut", reason: "tier" });
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
    // An apostrophe is dropped, not turned into a hyphen (ADR-198).
    expect(agentSlugFor("Mac's MacBook")).toBe("cc-macs-macbook");
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
