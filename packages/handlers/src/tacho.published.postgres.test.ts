// The Tacho port bound to the version store (#4550): the key a workspace's
// version is read by, the organization answer, file reads at the version's
// commit with the blob check and the cache, and recall_unreviewed as the
// published governance file puts it in force.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import { GOVERNANCE_TOML_PATH } from "@oxagen/oxagen/steering-repo/paths";
import { schemaDirective } from "@oxagen/oxagen/steering-repo/schema-ids";
import { gitBlobId } from "@oxagen/steering-bundle";
import type { SteeringRepository } from "./context.steering.github";
import type { readSteeringConnection } from "./context.steering.host";
import { steeringRepositoryKey } from "./steering-repo/publisher";
import type { TachoPublished } from "./tacho.published";
import { createPostgresTachoPublished } from "./tacho.published.postgres";

type Connection = Awaited<ReturnType<typeof readSteeringConnection>>;
type Scope = { orgId: string; workspaceId: string };

const SCOPE: Scope = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const OTHER_WORKSPACE: Scope = {
  orgId: SCOPE.orgId,
  workspaceId: "00000000-0000-4000-8000-000000000003",
};
const COMMIT = "c0ffee0000000000000000000000000000000001";
const KEY = "github.com/a-intel/steering";
const MEMORY = "memory/billing-tests.md";
const TEXT = "Run the billing tests before a proration change.\n";

const BINDING: NonNullable<Connection> = {
  provider: "github",
  source: "binding",
  owner: "A-Intel",
  repo: "Steering",
  approvedFullName: "A-Intel/Steering",
  approvedDefaultRef: "main",
};
const REPO: SteeringRepository = {
  provider: "github",
  owner: "A-Intel",
  repo: "Steering",
  fullName: "A-Intel/Steering",
  currentFullName: "A-Intel/Steering",
  defaultBranch: "main",
};

function version(commit = COMMIT, repository = KEY): Bundle {
  return {
    schema: "bundle/v1",
    repository,
    scope: "workspace",
    organization: "a-intel",
    version: 3,
    commit,
    records: [],
  } as unknown as Bundle;
}

const at = (commit: string, path: string) => `${commit}:${path}`;

function governance(...lines: string[]): string {
  return [
    schemaDirective("governance/v1"),
    'schema = "governance/v1"',
    ...lines,
    "",
  ].join("\n");
}

interface Setup {
  /** The workspace's binding. BINDING when unset; null for none. */
  connection?: Connection;
  /** The published versions, by their repository. One at COMMIT when unset. */
  versions?: Bundle[];
  /** File bodies by `<commit>:<path>`. */
  files?: Record<string, string>;
  /** The handle the host resolves. REPO when unset. */
  repo?: SteeringRepository;
  cacheEntries?: number;
  cacheBytes?: number;
}

function setup(options: Setup = {}) {
  const versions = new Map(
    (options.versions ?? [version()]).map((held): [string, Bundle] => [
      held.repository,
      held,
    ]),
  );
  const files = new Map(Object.entries(options.files ?? {}));
  // The Postgres store parses a fresh object on each read, and so does this.
  const current = vi.fn(async (repository: string): Promise<Bundle | null> => {
    const held = versions.get(repository);
    return held === undefined ? null : { ...held };
  });
  const store = vi.fn((_scope: Scope) => ({ current }));
  const readConnection = vi.fn(
    async (_scope: Scope): Promise<Connection> =>
      options.connection === undefined ? BINDING : options.connection,
  );
  const resolveRepository = vi.fn(
    async (_scope: Scope): Promise<SteeringRepository> => options.repo ?? REPO,
  );
  const readFile = vi.fn(
    async (
      _repo: SteeringRepository,
      path: string,
      ref: string,
    ): Promise<string | null> => files.get(at(ref, path)) ?? null,
  );
  const warn = vi.fn();
  const published = createPostgresTachoPublished({
    store,
    readConnection,
    host: { resolveRepository, readFile },
    log: { warn },
    cacheEntries: options.cacheEntries,
    cacheBytes: options.cacheBytes,
  });
  return {
    published,
    store,
    current,
    readConnection,
    resolveRepository,
    readFile,
    warn,
  };
}

async function workspaceVersion(
  published: TachoPublished,
  scope: Scope = SCOPE,
): Promise<Bundle> {
  const { workspace } = await published.published({ ...scope, runId: null });
  if (workspace === null) throw new Error("No version is published.");
  return workspace;
}

describe("published", () => {
  it("reads the workspace's version under the key its binding names", async () => {
    const t = setup();
    await expect(
      t.published.published({ ...SCOPE, runId: null }),
    ).resolves.toEqual({ workspace: version(), organization: null });
    expect(t.readConnection).toHaveBeenCalledWith(SCOPE);
    expect(t.store).toHaveBeenCalledWith(SCOPE);
    expect(t.current).toHaveBeenCalledWith(KEY);
    expect(t.resolveRepository).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    connection: NonNullable<Connection>;
    handle: SteeringRepository;
    key: string;
  }>([
    {
      name: "GitHub",
      connection: BINDING,
      handle: { ...REPO, currentFullName: "A-Intel/Renamed" },
      key: KEY,
    },
    {
      name: "GitLab nested-group",
      connection: {
        provider: "gitlab",
        source: "binding",
        owner: "Acme/Platform/Tools",
        repo: "Steering",
        approvedFullName: "Acme/Platform/Tools/Steering",
        approvedDefaultRef: "main",
      },
      handle: {
        provider: "gitlab",
        projectId: "4242",
        owner: "Acme/Platform/Tools",
        repo: "Steering",
        fullName: "Acme/Platform/Tools/Steering",
        currentFullName: "acme/moved/steering",
        defaultBranch: "main",
      },
      key: "gitlab.com/acme/platform/tools/steering",
    },
  ])(
    "keys a $name binding as the publisher keys the handle its host resolves",
    async ({ connection, handle, key }) => {
      const t = setup({ connection, versions: [] });
      await t.published.published({ ...SCOPE, runId: null });
      expect(steeringRepositoryKey(handle)).toBe(key);
      expect(t.current).toHaveBeenCalledWith(key);
      expect(t.resolveRepository).not.toHaveBeenCalled();
    },
  );

  it("is null before the first publish", async () => {
    const t = setup({ versions: [] });
    await expect(
      t.published.published({ ...SCOPE, runId: null }),
    ).resolves.toEqual({ workspace: null, organization: null });
  });

  it("is null for a workspace with no steering binding", async () => {
    const t = setup({ connection: null });
    await expect(
      t.published.published({ ...SCOPE, runId: null }),
    ).resolves.toEqual({ workspace: null, organization: null });
    expect(t.store).not.toHaveBeenCalled();
  });

  it("keys a legacy connection by the repository its host resolves, and reads files through that handle", async () => {
    const t = setup({
      connection: {
        provider: "github",
        source: "legacy_delivery_config",
        owner: "a-intel",
        repo: "steering",
      },
      files: { [at(COMMIT, MEMORY)]: TEXT },
    });
    const bundle = await workspaceVersion(t.published);
    expect(t.current).toHaveBeenCalledWith(KEY);
    await expect(
      t.published.readAsset("workspace", bundle, {
        path: MEMORY,
        blob: gitBlobId(TEXT),
      }),
    ).resolves.toBe(TEXT);
    expect(t.resolveRepository).toHaveBeenCalledTimes(1);
  });

  it("lets a failed read of the binding fail the call", async () => {
    const t = setup();
    t.readConnection.mockRejectedValueOnce(new Error("connection refused"));
    await expect(
      t.published.published({ ...SCOPE, runId: null }),
    ).rejects.toThrow("connection refused");
  });
});

describe("readAsset", () => {
  it("reads the file at the version's commit and checks it against its blob", async () => {
    const t = setup({ files: { [at(COMMIT, MEMORY)]: TEXT } });
    const bundle = await workspaceVersion(t.published);
    await expect(
      t.published.readAsset("workspace", bundle, {
        path: MEMORY,
        blob: gitBlobId(TEXT),
      }),
    ).resolves.toBe(TEXT);
    expect(t.resolveRepository).toHaveBeenCalledWith(SCOPE);
    expect(t.readFile).toHaveBeenCalledWith(REPO, MEMORY, COMMIT);
  });

  it("keeps a body by its blob, so a later request reads nothing from the forge", async () => {
    const t = setup({ files: { [at(COMMIT, MEMORY)]: TEXT } });
    const file = { path: MEMORY, blob: gitBlobId(TEXT) };
    await t.published.readAsset(
      "workspace",
      await workspaceVersion(t.published),
      file,
    );
    await expect(
      t.published.readAsset(
        "workspace",
        await workspaceVersion(t.published),
        file,
      ),
    ).resolves.toBe(TEXT);
    expect(t.readFile).toHaveBeenCalledTimes(1);
    expect(t.resolveRepository).toHaveBeenCalledTimes(1);
  });

  it("resolves the repository once for a version's concurrent reads", async () => {
    const paths = ["memory/a.md", "memory/b.md", "memory/c.md"];
    const t = setup({
      files: Object.fromEntries(paths.map((path) => [at(COMMIT, path), `${path}\n`])),
    });
    const bundle = await workspaceVersion(t.published);
    await Promise.all(
      paths.map((path) =>
        t.published.readAsset("workspace", bundle, {
          path,
          blob: gitBlobId(`${path}\n`),
        }),
      ),
    );
    expect(t.resolveRepository).toHaveBeenCalledTimes(1);
    expect(t.readFile).toHaveBeenCalledTimes(3);
  });

  it("refuses a body that does not hash to its blob, and keeps nothing", async () => {
    const t = setup({ files: { [at(COMMIT, MEMORY)]: TEXT } });
    const bundle = await workspaceVersion(t.published);
    const file = { path: MEMORY, blob: gitBlobId("An edited statement.\n") };
    await expect(
      t.published.readAsset("workspace", bundle, file),
    ).rejects.toThrow(/hashes to/);
    await expect(
      t.published.readAsset("workspace", bundle, file),
    ).rejects.toThrow(/hashes to/);
    expect(t.readFile).toHaveBeenCalledTimes(2);
  });

  it("checks a SHA-256 blob id with SHA-256", async () => {
    const bytes = Buffer.from(TEXT, "utf8");
    const blob = createHash("sha256")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    const t = setup({ files: { [at(COMMIT, MEMORY)]: TEXT } });
    const bundle = await workspaceVersion(t.published);
    await expect(
      t.published.readAsset("workspace", bundle, { path: MEMORY, blob }),
    ).resolves.toBe(TEXT);
  });

  it("refuses a file the version's commit does not hold", async () => {
    const t = setup();
    const bundle = await workspaceVersion(t.published);
    await expect(
      t.published.readAsset("workspace", bundle, {
        path: MEMORY,
        blob: gitBlobId(TEXT),
      }),
    ).rejects.toThrow(`${MEMORY} is not in ${KEY} at ${COMMIT}.`);
  });

  it("refuses a version whose repository the steering head no longer names", async () => {
    const t = setup({
      repo: { ...REPO, fullName: "A-Intel/Other" },
      files: { [at(COMMIT, MEMORY)]: TEXT },
    });
    const bundle = await workspaceVersion(t.published);
    await expect(
      t.published.readAsset("workspace", bundle, {
        path: MEMORY,
        blob: gitBlobId(TEXT),
      }),
    ).rejects.toThrow(/steering repo is github\.com\/a-intel\/other now/);
    expect(t.readFile).not.toHaveBeenCalled();
  });

  it("refuses an organization read, and a version this reader did not return", async () => {
    const t = setup({ files: { [at(COMMIT, MEMORY)]: TEXT } });
    const file = { path: MEMORY, blob: gitBlobId(TEXT) };
    const bundle = await workspaceVersion(t.published);
    await expect(
      t.published.readAsset("organization", bundle, file),
    ).rejects.toThrow(/No organization version/);
    await expect(
      t.published.readAsset("workspace", version(), file),
    ).rejects.toThrow(/did not return/);
    expect(t.readFile).not.toHaveBeenCalled();
  });

  it("keeps only the most recently used bodies within its byte budget", async () => {
    const A = "memory/a.md";
    const B = "memory/b.md";
    const C = "memory/c.md";
    const t = setup({
      files: Object.fromEntries([A, B, C].map((path) => [at(COMMIT, path), `${path}\n`])),
      // Each body is 12 bytes, so the budget holds two of them.
      cacheBytes: 24,
    });
    const bundle = await workspaceVersion(t.published);
    for (const path of [A, B, A, C, A, B]) {
      await t.published.readAsset("workspace", bundle, {
        path,
        blob: gitBlobId(`${path}\n`),
      });
    }
    // A is read again before C arrives, so C evicts B, and A stays.
    expect(t.readFile.mock.calls.map(([, path]) => path)).toEqual([A, B, C, B]);
  });

  it("keeps no body larger than the whole budget", async () => {
    const t = setup({
      files: { [at(COMMIT, MEMORY)]: TEXT },
      cacheBytes: Buffer.byteLength(TEXT) - 1,
    });
    const bundle = await workspaceVersion(t.published);
    const file = { path: MEMORY, blob: gitBlobId(TEXT) };
    await t.published.readAsset("workspace", bundle, file);
    await expect(
      t.published.readAsset("workspace", bundle, file),
    ).resolves.toBe(TEXT);
    expect(t.readFile).toHaveBeenCalledTimes(2);
  });

  it("puts back a byte order mark the host dropped, so the blob still matches", async () => {
    const BOM = "\uFEFF";
    // GitLab's read decodes with Response.text(), which drops a leading mark.
    const t = setup({ files: { [at(COMMIT, MEMORY)]: TEXT } });
    const bundle = await workspaceVersion(t.published);
    const file = { path: MEMORY, blob: gitBlobId(BOM + TEXT) };
    await expect(
      t.published.readAsset("workspace", bundle, file),
    ).resolves.toBe(BOM + TEXT);
    await expect(
      t.published.readAsset("workspace", bundle, file),
    ).resolves.toBe(BOM + TEXT);
    expect(t.readFile).toHaveBeenCalledTimes(1);
  });

  it("keeps a byte order mark the host returned", async () => {
    const BOM = "\uFEFF";
    const t = setup({ files: { [at(COMMIT, MEMORY)]: BOM + TEXT } });
    const bundle = await workspaceVersion(t.published);
    await expect(
      t.published.readAsset("workspace", bundle, {
        path: MEMORY,
        blob: gitBlobId(BOM + TEXT),
      }),
    ).resolves.toBe(BOM + TEXT);
  });

  it("never answers one workspace's read from another's body", async () => {
    const t = setup({ files: { [at(COMMIT, MEMORY)]: TEXT } });
    const file = { path: MEMORY, blob: gitBlobId(TEXT) };
    await t.published.readAsset(
      "workspace",
      await workspaceVersion(t.published, SCOPE),
      file,
    );
    await t.published.readAsset(
      "workspace",
      await workspaceVersion(t.published, OTHER_WORKSPACE),
      file,
    );
    expect(t.readFile).toHaveBeenCalledTimes(2);
    expect(t.resolveRepository).toHaveBeenLastCalledWith(OTHER_WORKSPACE);
  });
});

describe("recallUnreviewed", () => {
  it.each<{ name: string; lines: string[]; expected: "same-agent" | "off" }>([
    {
      name: "the setting the file puts in force",
      lines: ['mode = "team"', "", "[memory]", 'recall_unreviewed = "off"'],
      expected: "off",
    },
    {
      name: "the default when the file sets none",
      lines: ['mode = "team"'],
      expected: "same-agent",
    },
    {
      name: "off in regulated mode whatever the file sets",
      lines: [
        'mode = "regulated"',
        "",
        "[memory]",
        'recall_unreviewed = "same-agent"',
      ],
      expected: "off",
    },
  ])("answers $name, from the published commit", async ({ lines, expected }) => {
    const t = setup({
      files: { [at(COMMIT, GOVERNANCE_TOML_PATH)]: governance(...lines) },
    });
    await expect(t.published.recallUnreviewed(SCOPE)).resolves.toBe(expected);
    expect(t.readFile).toHaveBeenCalledWith(REPO, GOVERNANCE_TOML_PATH, COMMIT);
    expect(t.warn).not.toHaveBeenCalled();
  });

  it("reads the governance file once per published commit", async () => {
    const t = setup({
      files: { [at(COMMIT, GOVERNANCE_TOML_PATH)]: governance('mode = "team"') },
    });
    await t.published.recallUnreviewed(SCOPE);
    await expect(t.published.recallUnreviewed(SCOPE)).resolves.toBe(
      "same-agent",
    );
    expect(t.readFile).toHaveBeenCalledTimes(1);
  });

  it.each<{ name: string; connection?: Connection; versions?: Bundle[] }>([
    { name: "before the first publish", versions: [] },
    { name: "for a workspace with no steering binding", connection: null },
  ])("is off $name, and logs nothing", async ({ connection, versions }) => {
    const t = setup({ connection, versions });
    await expect(t.published.recallUnreviewed(SCOPE)).resolves.toBe("off");
    expect(t.readFile).not.toHaveBeenCalled();
    expect(t.warn).not.toHaveBeenCalled();
  });

  it.each<{ name: string; files: Record<string, string> }>([
    { name: "holds no governance file", files: {} },
    {
      name: "holds a governance file that does not parse",
      files: { [at(COMMIT, GOVERNANCE_TOML_PATH)]: "mode = team\n" },
    },
  ])("is off when the version $name, and logs it once", async ({ files }) => {
    const t = setup({ files });
    await expect(t.published.recallUnreviewed(SCOPE)).resolves.toBe("off");
    await expect(t.published.recallUnreviewed(SCOPE)).resolves.toBe("off");
    expect(t.readFile).toHaveBeenCalledTimes(1);
    expect(t.warn).toHaveBeenCalledTimes(1);
    expect(t.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: SCOPE.workspaceId,
        repository: KEY,
        commit: COMMIT,
      }),
      expect.stringContaining("stay off"),
    );
  });

  it("is off when the read fails, and reads again on the next call", async () => {
    const t = setup({
      files: { [at(COMMIT, GOVERNANCE_TOML_PATH)]: governance('mode = "team"') },
    });
    t.readFile.mockRejectedValueOnce(new Error("GitHub answered 502"));
    await expect(t.published.recallUnreviewed(SCOPE)).resolves.toBe("off");
    expect(t.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: SCOPE.workspaceId,
        err: "GitHub answered 502",
      }),
      expect.stringContaining("stay off"),
    );
    await expect(t.published.recallUnreviewed(SCOPE)).resolves.toBe(
      "same-agent",
    );
    expect(t.readFile).toHaveBeenCalledTimes(2);
  });

  it("is off when the version store fails", async () => {
    const t = setup();
    t.current.mockRejectedValueOnce(new Error("connection refused"));
    await expect(t.published.recallUnreviewed(SCOPE)).resolves.toBe("off");
    expect(t.warn).toHaveBeenCalledTimes(1);
  });
});
