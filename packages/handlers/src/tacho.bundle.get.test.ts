/**
 * `get_tacho_bundle` against a host holding an unchanged mandate: a poll
 * with its etag is told `not_modified`; a poll without one, which is how a
 * host renews a quiet mandate past half its signed window, is sent the same
 * mandate signed again; and the version names the mandate, not the fetch.
 */
import { generateKeyPairSync } from "node:crypto";
import type { CapabilityContext } from "@oxagen/oxagen";
import { requireCedarRuntime } from "@oxagen/policy";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { BUNDLE_FEATURE_CEDAR, policyBundleSchema } from "@oxagen/recorder";
import { bundleSignerFromPem, verifyBundle } from "./lib/tacho-bundle-signing";
import { CedarPoliciesUnavailableError } from "./lib/tacho-host-cedar";
import {
  BROKEN_POLICY,
  CEDAR_RUNTIME,
  cedarPort,
  cedarVersion,
  NO_SHELL_ID,
  RELEASE_BOT,
  REVIEWER,
  REVIEWER_NO_SHELL_ID,
} from "./lib/tacho-host-cedar.test-support";
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
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...original, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
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
        // The runtime a host that parses Cedar binds (`resolveHostCedar`).
        query: {
          runtimes: { findFirst: async () => ({ slug: CEDAR_RUNTIME }) },
        },
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
    expect(answer.bundle).not.toHaveProperty("cedar");
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

  /** The fixture's skills a host receives, and a file of the first one's. */
  async function firstSkillFile() {
    mocks.host.mockReturnValue(hostRow(SKILLS_HOST));
    const whole = await createTachoBundleGetHandler({ published: port() })(
      { host_enrollment_id: HOST_PUBLIC },
      MACHINE,
    );
    const lineages = (whole.bundle?.skills ?? []).map((skill) => skill.lineage);
    // The fixture's workspace publishes two skills that every repository receives.
    expect(lineages.length).toBeGreaterThanOrEqual(2);
    const first = whole.bundle?.skills?.[0];
    const record = (await fixtureDelivery())[first?.source ?? "workspace"]?.records.find(
      (held) => held.kind === "skill" && held.lineage === first?.lineage,
    );
    if (first === undefined || record === undefined) {
      throw new Error("The fixture publishes no skill.");
    }
    // An asset rather than SKILL.md, as a binary asset would fail.
    const path =
      record.files?.find((file) => file.path !== record.path)?.path ??
      record.path;
    return { lineages, lineage: first.lineage, source: first.source, path };
  }

  /** The fixture's port, with one file that fails while `broken.on` holds. */
  function breaking(source: string, path: string) {
    const broken = { on: true };
    const published = port();
    const read = published.readAsset;
    published.readAsset = (from, bundle, file) => {
      if (broken.on && from === source && file.path === path) {
        published.reads += 1;
        return Promise.reject(new Error(`${file.path} is not UTF-8`));
      }
      return read(from, bundle, file);
    };
    return { published, broken };
  }

  it("leaves out only the skill whose file cannot be read", async () => {
    const { lineages, lineage, source, path } = await firstSkillFile();
    mocks.host.mockReturnValue(hostRow(SKILLS_HOST));
    const { published } = breaking(source, path);
    const answer = await createTachoBundleGetHandler({ published })(
      { host_enrollment_id: HOST_PUBLIC },
      MACHINE,
    );
    expect((answer.bundle?.skills ?? []).map((skill) => skill.lineage)).toEqual(
      lineages.filter((held) => held !== lineage),
    );
  });

  it("reads a left-out skill again after ten minutes", async () => {
    const { lineages, source, path } = await firstSkillFile();
    mocks.host.mockReturnValue(hostRow(SKILLS_HOST));
    const { published, broken } = breaking(source, path);
    const handler = createTachoBundleGetHandler({ published });
    const first = await handler({ host_enrollment_id: HOST_PUBLIC }, MACHINE);
    expect(first.bundle?.skills?.length).toBe(lineages.length - 1);
    const reads = published.reads;
    // Inside the ten minutes, the partial skills answer and nothing is read.
    vi.setSystemTime(new Date(NOW.getTime() + 9 * 60 * 1000));
    await handler({ host_enrollment_id: HOST_PUBLIC }, MACHINE);
    expect(published.reads).toBe(reads);
    // The forge recovers, and the next poll after ten minutes reads it.
    broken.on = false;
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60 * 1000));
    const later = await handler({ host_enrollment_id: HOST_PUBLIC }, MACHINE);
    expect(published.reads).toBeGreaterThan(reads);
    expect((later.bundle?.skills ?? []).map((skill) => skill.lineage)).toEqual(
      lineages,
    );
  });

  it("reads the published skills outside any tenant transaction", async () => {
    // The version store's port opens tenant transactions of its own, so a
    // read made inside the handler's would hold one pool connection while it
    // waits for another.
    let open = 0;
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        open += 1;
        try {
          return await fn({
            update: () => ({
              set: (values: Record<string, unknown>) => ({
                where: async () => {
                  writes.push(values);
                },
              }),
            }),
          });
        } finally {
          open -= 1;
        }
      },
    );
    const outside = <T>(read: () => Promise<T>) => async (): Promise<T> => {
      if (open > 0) throw new Error("read inside a tenant transaction");
      return read();
    };
    mocks.host.mockReturnValue(hostRow(SKILLS_HOST));
    const counted = port();
    const read = counted.readAsset;
    counted.published = outside(() => fixtureDelivery());
    counted.readAsset = (source, bundle, file) =>
      outside(() => read(source, bundle, file))();
    const answer = await createTachoBundleGetHandler({ published: counted })(
      { host_enrollment_id: HOST_PUBLIC },
      MACHINE,
    );
    expect(answer.bundle?.skills?.length).toBeGreaterThan(0);
    expect(counted.reads).toBeGreaterThan(0);
    expect(writes).toHaveLength(1);
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

describe("get_tacho_bundle Cedar", () => {
  /** A host that parses Cedar and binds the runtime two of the fixture's agents run on. */
  const CEDAR_HOST = {
    bundleFeatures: [BUNDLE_FEATURE_CEDAR],
    runtimeId: "22222222-2222-4222-8222-222222222222",
  };

  beforeAll(async () => {
    // Loaded once per process, before the fake timers start.
    await requireCedarRuntime();
  });

  it("sends a host that parses Cedar the published policies, and a newly published version on its next fetch", async () => {
    const port = cedarPort();
    const handler = createTachoBundleGetHandler({ published: port });
    mocks.host.mockReturnValue(hostRow(CEDAR_HOST));
    const first = await handler({ host_enrollment_id: HOST_PUBLIC }, MACHINE);
    expect(first.bundle?.cedar?.policies).toHaveProperty(NO_SHELL_ID);
    expect(
      first.bundle?.cedar?.principals.map((agent) => agent.name).sort(),
    ).toEqual([RELEASE_BOT, REVIEWER].sort());
    expect(first.bundle && policyBundleSchema.parse(first.bundle).cedar).toEqual(
      first.bundle?.cedar,
    );
    expect(
      first.bundle &&
        verifyBundle(first.bundle, bundleSignerFromPem(PEM).publicKeyPem),
    ).toBe(true);

    // While the version stands, a poll with its etag is not_modified.
    mocks.host.mockReturnValue(
      hostRow({ ...CEDAR_HOST, bundleEtagServed: first.etag }),
    );
    const same = await handler(
      { host_enrollment_id: HOST_PUBLIC, etag: first.etag },
      MACHINE,
    );
    expect(same).toEqual({ not_modified: true, etag: first.etag, bundle: null });

    // A newly published version moves the etag, so the host's next fetch
    // with the etag it holds gets the new policies.
    port.version = cedarVersion({ version: 2 });
    mocks.host.mockReturnValue(
      hostRow({
        ...CEDAR_HOST,
        bundleEtagServed: first.etag,
        bundleVersionServed: 5,
      }),
    );
    const next = await handler(
      { host_enrollment_id: HOST_PUBLIC, etag: first.etag },
      MACHINE,
    );
    expect(next.not_modified).toBe(false);
    expect(next.etag).not.toBe(first.etag);
    expect(next.bundle?.cedar?.policies).toHaveProperty(REVIEWER_NO_SHELL_ID);
    expect(next.bundle?.version).toBe(6);
    expect(writes.at(-1)).toMatchObject({
      bundleEtagServed: next.etag,
      bundleVersionServed: 6,
    });
  });

  it("sends no Cedar and keeps the etag when nothing has published", async () => {
    const base = await currentEtag();
    mocks.host.mockReturnValue(hostRow(CEDAR_HOST));
    const answer = await createTachoBundleGetHandler({
      published: NOTHING_PUBLISHED,
    })({ host_enrollment_id: HOST_PUBLIC }, MACHINE);
    expect(answer.bundle).not.toHaveProperty("cedar");
    expect(answer.etag).toBe(base);
  });

  it("fails the request when the published policies do not compile and none have compiled (#5390)", async () => {
    // A bundle signed without Cedar would let the host allow every call the
    // policies forbid, so the request fails and the host keeps the bundle it
    // holds.
    mocks.host.mockReturnValue(hostRow(CEDAR_HOST));
    await expect(
      createTachoBundleGetHandler({
        published: cedarPort(cedarVersion({ policies: [BROKEN_POLICY] })),
      })({ host_enrollment_id: HOST_PUBLIC }, MACHINE),
    ).rejects.toThrow(CedarPoliciesUnavailableError);
    expect(writes).toEqual([]);
  });

  it("keeps the etag the host holds when the published policies cannot be read", async () => {
    const port = cedarPort();
    const handler = createTachoBundleGetHandler({ published: port });
    mocks.host.mockReturnValue(hostRow(CEDAR_HOST));
    const first = await handler({ host_enrollment_id: HOST_PUBLIC }, MACHINE);
    expect(first.bundle?.cedar?.policies).toHaveProperty(NO_SHELL_ID);

    // The version store goes down. The process serves the set it compiled,
    // so the host's poll with its etag is not_modified and its policies stay.
    port.published = async () => {
      throw new Error("the version store is down");
    };
    mocks.host.mockReturnValue(
      hostRow({ ...CEDAR_HOST, bundleEtagServed: first.etag }),
    );
    const same = await handler(
      { host_enrollment_id: HOST_PUBLIC, etag: first.etag },
      MACHINE,
    );
    expect(same).toEqual({ not_modified: true, etag: first.etag, bundle: null });
  });

  it("fails the request when the published policies cannot be read and none have compiled", async () => {
    // A fresh port, so its reader holds no earlier set. A bundle signed
    // without Cedar would let the host allow every call the policies forbid,
    // so the request fails and the host keeps the bundle it holds (#5381).
    const port = cedarPort();
    port.published = async () => {
      throw new Error("the version store is down");
    };
    mocks.host.mockReturnValue(hostRow(CEDAR_HOST));
    await expect(
      createTachoBundleGetHandler({ published: port })(
        { host_enrollment_id: HOST_PUBLIC },
        MACHINE,
      ),
    ).rejects.toThrow(CedarPoliciesUnavailableError);
    // Nothing was served, so the host row records no new etag.
    expect(writes).toEqual([]);
  });
});
