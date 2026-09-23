/**
 * `get_tacho_bundle` against a host holding an unchanged mandate: a host
 * whose bundle is recent is told `not_modified`; one whose bundle is past
 * half its signed window is sent the same mandate signed again, so a hook
 * that measures from `issued_at` never sees a lapsed mandate; and the
 * version names the mandate, not the fetch.
 */
import { generateKeyPairSync } from "node:crypto";
import type { CapabilityContext } from "@oxagen/oxagen";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleSignerFromPem, verifyBundle } from "./lib/tacho-bundle-signing";
import { tachoBundleGetHandler } from "./tacho.bundle.get";

const PEM = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  host: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  return { ...original, withTenantDb: mocks.withTenantDb };
});

vi.mock("./lib/tacho-host", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/tacho-host")>();
  return {
    ...original,
    resolveEnrolledHost: async () => mocks.host(),
    readDenyGeneration: async () => ({ org: 1, workspace: 0 }),
    readWorkspaceRetention: async () => ({
      mode: "digest_only",
      classes: [],
    }),
    resolveHostMandate: async () => ({
      permissions: { allow: [], deny: [], ask: [] },
      budget: { mode: "observed" },
    }),
  };
});

vi.mock("./lib/tacho-steering", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./lib/tacho-steering")>();
  return {
    ...original,
    readWorkspaceSteering: async () =>
      original.assembleWorkspaceSteering("org", "ws", []),
  };
});

const MACHINE: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: null,
  apiKeyId: "aky_host",
  requestId: "req_1",
  surface: "api",
  messageId: null,
};
const HOST_PUBLIC = "tch_0123456789abcdefghjkmn";
const NOW = new Date("2026-09-23T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function hostRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    publicId: HOST_PUBLIC,
    status: "active",
    mode: "observe",
    bundleFeatures: [],
    bundleVersionServed: 4,
    bundleEtagServed: null,
    lastBundleFetchAt: null,
    createdAt: new Date(NOW.getTime() - 30 * 24 * HOUR),
    ...overrides,
  };
}

/** The values each call wrote to the host row. */
let writes: Array<Record<string, unknown>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("TACHO_BUNDLE_SIGNING_PRIVATE_KEY", PEM.replace(/\n/g, "\\n"));
  writes = [];
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: () => ({
          set: (values: Record<string, unknown>) => ({
            where: async () => {
              writes.push(values);
            },
          }),
        }),
      }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/** The etag the current mandate carries, from a first fetch with none. */
async function currentEtag(): Promise<string> {
  mocks.host.mockReturnValue(hostRow());
  const first = await tachoBundleGetHandler(
    { host_enrollment_id: HOST_PUBLIC },
    MACHINE,
  );
  writes = [];
  return first.etag;
}

describe("get_tacho_bundle freshness", () => {
  it("answers not_modified while the host's bundle is inside half its window", async () => {
    const etag = await currentEtag();
    mocks.host.mockReturnValue(
      hostRow({
        bundleEtagServed: etag,
        lastBundleFetchAt: new Date(NOW.getTime() - 11 * HOUR),
      }),
    );
    const answer = await tachoBundleGetHandler(
      { host_enrollment_id: HOST_PUBLIC, etag },
      MACHINE,
    );
    expect(answer).toEqual({ not_modified: true, etag, bundle: null });
    // A check is not a fetch: the issue time stays the bundle's.
    expect(writes[0]).not.toHaveProperty("lastBundleFetchAt");
    expect(writes[0]?.["bundleVersionServed"]).toBe(4);
  });

  it("re-signs an unchanged mandate once the host's bundle is past half its window", async () => {
    const etag = await currentEtag();
    mocks.host.mockReturnValue(
      hostRow({
        bundleEtagServed: etag,
        lastBundleFetchAt: new Date(NOW.getTime() - 13 * HOUR),
      }),
    );
    const answer = await tachoBundleGetHandler(
      { host_enrollment_id: HOST_PUBLIC, etag },
      MACHINE,
    );
    expect(answer.not_modified).toBe(false);
    expect(answer.etag).toBe(etag);
    expect(answer.bundle?.issued_at).toBe(NOW.toISOString());
    // The same mandate keeps its version.
    expect(answer.bundle?.version).toBe(4);
    expect(
      answer.bundle &&
        verifyBundle(answer.bundle, bundleSignerFromPem(PEM).publicKeyPem),
    ).toBe(true);
    expect(writes[0]).toMatchObject({
      lastBundleFetchAt: NOW,
      bundleVersionServed: 4,
    });
  });

  it("re-signs an enrollment bundle, dated by the host row, once it is old", async () => {
    const etag = await currentEtag();
    mocks.host.mockReturnValue(
      hostRow({ bundleEtagServed: etag, bundleVersionServed: null }),
    );
    const answer = await tachoBundleGetHandler(
      { host_enrollment_id: HOST_PUBLIC, etag },
      MACHINE,
    );
    expect(answer.not_modified).toBe(false);
    expect(answer.bundle?.version).toBe(1);
    mocks.host.mockReturnValue(
      hostRow({
        bundleEtagServed: etag,
        bundleVersionServed: null,
        createdAt: new Date(NOW.getTime() - HOUR),
      }),
    );
    expect(
      (
        await tachoBundleGetHandler(
          { host_enrollment_id: HOST_PUBLIC, etag },
          MACHINE,
        )
      ).not_modified,
    ).toBe(true);
  });

  it("bumps the version only when the etag changes", async () => {
    const etag = await currentEtag();
    mocks.host.mockReturnValue(
      hostRow({ bundleEtagServed: "an-older-mandate" }),
    );
    const changed = await tachoBundleGetHandler(
      { host_enrollment_id: HOST_PUBLIC, etag: "an-older-mandate" },
      MACHINE,
    );
    expect(changed.not_modified).toBe(false);
    expect(changed.bundle?.version).toBe(5);
    expect(writes[0]).toMatchObject({
      bundleEtagServed: etag,
      bundleVersionServed: 5,
    });
  });
});
