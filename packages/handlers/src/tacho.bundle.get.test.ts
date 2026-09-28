/**
 * `get_tacho_bundle` against a host holding an unchanged mandate: a poll
 * with its etag is told `not_modified`; a poll without one, which is how a
 * host renews a quiet mandate past half its signed window, is sent the same
 * mandate signed again; and the version names the mandate, not the fetch.
 */
import { generateKeyPairSync } from "node:crypto";
import type { CapabilityContext } from "@oxagen/oxagen";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { policyBundleSchema } from "@oxagen/tacho";
import { bundleSignerFromPem, verifyBundle } from "./lib/tacho-bundle-signing";
import {
  fixtureDelivery,
  readFixtureFile,
} from "./steering.test-support";
import {
  createTachoBundleGetHandler,
  tachoBundleGetHandler,
} from "./tacho.bundle.get";
import { NOTHING_PUBLISHED, type TachoPublished } from "./tacho.published";

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
  it("answers not_modified on a matching etag and keeps the version", async () => {
    const etag = await currentEtag();
    mocks.host.mockReturnValue(hostRow({ bundleEtagServed: etag }));
    const answer = await tachoBundleGetHandler(
      { host_enrollment_id: HOST_PUBLIC, etag },
      MACHINE,
    );
    expect(answer).toEqual({ not_modified: true, etag, bundle: null });
    expect(writes[0]?.["bundleVersionServed"]).toBe(4);
  });

  it("signs an unchanged mandate again for a poll without its etag", async () => {
    const etag = await currentEtag();
    mocks.host.mockReturnValue(
      hostRow({
        bundleEtagServed: etag,
        lastBundleFetchAt: new Date(NOW.getTime() - 13 * HOUR),
      }),
    );
    // The host's daemon drops the etag once its copy is past half its window.
    const answer = await tachoBundleGetHandler(
      { host_enrollment_id: HOST_PUBLIC },
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

describe("get_tacho_bundle skills", () => {
  const SKILLS_HOST = { bundleFeatures: ["skills"] };

  type CountedPort = TachoPublished & { reads: number };

  /** The fixture's published versions, counting each file read. */
  function port(overrides: Partial<TachoPublished> = {}): CountedPort {
    const counted: CountedPort = {
      reads: 0,
      published: () => fixtureDelivery(),
      readAsset: (source, bundle, file) => {
        counted.reads += 1;
        return readFixtureFile(source, bundle, file);
      },
      recallUnreviewed: async () => "off",
    };
    return Object.assign(counted, overrides);
  }

  it("sends a host that parses skills the published skills, signed with the mandate", async () => {
    mocks.host.mockReturnValue(hostRow(SKILLS_HOST));
    const handler = createTachoBundleGetHandler({ published: port() });
    const answer = await handler({ host_enrollment_id: HOST_PUBLIC }, MACHINE);
    const skills = answer.bundle?.skills ?? [];
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((skill) => skill.body.length > 0)).toBe(true);
    // The fixture's workspace publishes version 21.
    expect(skills.some((skill) => skill.source === "workspace" && skill.version === 21)).toBe(true);
    expect(answer.bundle && policyBundleSchema.parse(answer.bundle).skills).toEqual(skills);
    expect(
      answer.bundle &&
        verifyBundle(answer.bundle, bundleSignerFromPem(PEM).publicKeyPem),
    ).toBe(true);
    // The etag covers the skills, so a new published version reaches a host
    // that polls with its etag.
    expect(answer.etag).not.toBe(await currentEtag());
  });

  it("sends no skills to a host that did not advertise them, and reads nothing published", async () => {
    mocks.host.mockReturnValue(hostRow());
    const published = port({
      published: async () => {
        throw new Error("a host that did not ask should not cost a read");
      },
    });
    const answer = await createTachoBundleGetHandler({ published })(
      { host_enrollment_id: HOST_PUBLIC },
      MACHINE,
    );
    expect(answer.bundle).not.toBeNull();
    expect(answer.bundle).not.toHaveProperty("skills");
  });

  it("sends no skills and keeps the etag when nothing has published", async () => {
    const base = await currentEtag();
    mocks.host.mockReturnValue(hostRow(SKILLS_HOST));
    const answer = await createTachoBundleGetHandler({
      published: NOTHING_PUBLISHED,
    })({ host_enrollment_id: HOST_PUBLIC }, MACHINE);
    expect(answer.bundle).not.toHaveProperty("skills");
    expect(answer.etag).toBe(base);
  });

  it("still sends the mandate when a published file cannot be read", async () => {
    mocks.host.mockReturnValue(hostRow(SKILLS_HOST));
    const published = port({
      readAsset: async (_source, _bundle, file) => {
        throw new Error(`${file.path} is gone`);
      },
    });
    const answer = await createTachoBundleGetHandler({ published })(
      { host_enrollment_id: HOST_PUBLIC },
      MACHINE,
    );
    expect(answer.not_modified).toBe(false);
    expect(answer.bundle).not.toHaveProperty("skills");
    expect(answer.bundle?.permissions).toEqual({ allow: [], deny: [], ask: [] });
  });

  it("reads a published version once and answers not_modified while it stands", async () => {
    mocks.host.mockReturnValue(hostRow(SKILLS_HOST));
    const published = port();
    const handler = createTachoBundleGetHandler({ published });
    const first = await handler({ host_enrollment_id: HOST_PUBLIC }, MACHINE);
    const reads = published.reads;
    expect(reads).toBeGreaterThan(0);
    mocks.host.mockReturnValue(
      hostRow({ ...SKILLS_HOST, bundleEtagServed: first.etag }),
    );
    const second = await handler(
      { host_enrollment_id: HOST_PUBLIC, etag: first.etag },
      MACHINE,
    );
    expect(second).toEqual({ not_modified: true, etag: first.etag, bundle: null });
    expect(published.reads).toBe(reads);
  });
});
