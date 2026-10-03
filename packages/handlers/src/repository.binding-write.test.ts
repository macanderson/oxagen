// The one writer of a NEW binding head, shared by `create_workspace` and
// `link_repository`. What it has to get right is the version chain against
// `repository_bindings_repository_version_uq` on (connection, repository,
// version): a repository this connection bound before already HAS a version 1,
// so a second one would violate the index. The latest version is read across
// the workspace's connections, so a relink through a replacement connection
// continues the repository's one lineage (#3340).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubRepoInfo } from "@oxagen/github";
import { schema, type Tx } from "@oxagen/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  githubMainRepositoryDeps,
  writeRepositoryHead,
} from "./repository.binding-write";
import {
  githubTokenFetch,
  TEST_APP_PRIVATE_KEY,
} from "./test-utils/github-token-mint";

const REPO: GitHubRepoInfo = {
  id: "9001",
  owner: "Acme",
  name: "Widgets",
  fullName: "Acme/Widgets",
  htmlUrl: "https://github.com/Acme/Widgets",
  defaultBranch: "trunk",
};

const NOW = new Date("2026-09-18T10:00:00.000Z");
const SCOPE = { orgId: "org_1", workspaceId: "ws_1" };

/** The latest binding version this connection holds for REPO, as the read returns it. */
const LATEST = {
  id: "binding-1",
  publicId: "rpb_first",
  connectionId: "conn-uuid",
  version: 1,
  providerOwner: REPO.owner,
  providerName: REPO.name,
  providerFullName: REPO.fullName,
  configuredDefaultRef: REPO.defaultBranch,
};

interface Writes {
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
  /** The predicate of the one read. */
  where?: SQL;
}

/** A drizzle terminal that can be awaited or `.returning()`-ed. */
function rows(result: unknown[]) {
  return Object.assign(Promise.resolve(result), {
    returning: async () => result,
  });
}

/**
 * A transaction that answers the one read (select → from → where → orderBy →
 * limit) with `latest` and records every insert. The bindings insert returns
 * `inserted`; the heads insert returns nothing, which is how the writer awaits
 * it.
 */
function tx(opts: { latest?: unknown[]; inserted?: unknown[] }): {
  tx: Tx;
  writes: Writes;
} {
  const writes: Writes = { inserts: [] };
  const fake = {
    select: () => ({
      from: () => ({
        where: (where: SQL) => {
          writes.where = where;
          return {
            orderBy: () => ({ limit: async () => opts.latest ?? [] }),
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.inserts.push({ table, values });
        return rows(
          table === schema.repositoryBindings
            ? (opts.inserted ?? [{ id: "binding-new", publicId: "rpb_new" }])
            : [],
        );
      },
    }),
  };
  return { tx: fake as unknown as Tx, writes };
}

const args = (role: "steering" | "linked") => ({
  scope: SCOPE,
  connectionId: "conn-uuid",
  repo: REPO,
  role,
  userId: "u_1",
  now: NOW,
});

describe("writeRepositoryHead", () => {
  it("writes version 1 superseding nothing when this connection never bound the repository", async () => {
    const { tx: t, writes } = tx({ latest: [] });
    const out = await writeRepositoryHead(t, args("steering"));

    const binding = writes.inserts.find(
      (w) => w.table === schema.repositoryBindings,
    );
    expect(binding?.values).toMatchObject({
      orgId: "org_1",
      workspaceId: "ws_1",
      connectionId: "conn-uuid",
      provider: "github",
      providerRepositoryId: "9001",
      providerOwner: "Acme",
      providerName: "Widgets",
      providerFullName: "Acme/Widgets",
      configuredDefaultRef: "trunk",
      observedAt: NOW,
      version: 1,
      supersedesBindingId: null,
      createdAt: NOW,
      createdById: "u_1",
    });
    const head = writes.inserts.find(
      (w) => w.table === schema.repositoryBindingHeads,
    );
    expect(head?.values).toMatchObject({
      orgId: "org_1",
      workspaceId: "ws_1",
      connectionId: "conn-uuid",
      provider: "github",
      providerRepositoryId: "9001",
      currentBindingId: "binding-new",
      role: "steering",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(out).toEqual({ bindingPublicId: "rpb_new" });
  });

  it("reuses the latest version unchanged — a re-link after an unlink — and writes only the head", async () => {
    const { tx: t, writes } = tx({ latest: [LATEST] });
    const out = await writeRepositoryHead(t, args("linked"));

    // No second version 1: that is the index violation this read exists to
    // avoid. The head points at the version that already exists.
    expect(
      writes.inserts.filter((w) => w.table === schema.repositoryBindings),
    ).toHaveLength(0);
    const head = writes.inserts.find(
      (w) => w.table === schema.repositoryBindingHeads,
    );
    expect(head?.values).toMatchObject({
      currentBindingId: "binding-1",
      role: "linked",
    });
    expect(out).toEqual({ bindingPublicId: "rpb_first" });
  });

  it("supersedes with version + 1 naming its parent when the default ref moved", async () => {
    const { tx: t, writes } = tx({
      latest: [{ ...LATEST, version: 3, configuredDefaultRef: "main" }],
      inserted: [{ id: "binding-4", publicId: "rpb_fourth" }],
    });
    const out = await writeRepositoryHead(t, args("linked"));

    const binding = writes.inserts.find(
      (w) => w.table === schema.repositoryBindings,
    );
    // version + 1 and a parent: exactly what
    // `repository_bindings_supersedes_check` admits past version 1.
    expect(binding?.values).toMatchObject({
      version: 4,
      supersedesBindingId: "binding-1",
      configuredDefaultRef: "trunk",
    });
    const head = writes.inserts.find(
      (w) => w.table === schema.repositoryBindingHeads,
    );
    expect(head?.values).toMatchObject({
      currentBindingId: "binding-4",
      role: "linked",
    });
    expect(out).toEqual({ bindingPublicId: "rpb_fourth" });
  });

  // #3340 finding 7: an operator unlinks a repository whose connection was
  // retired and links it again through the connection that replaced it. The
  // lookup used to filter on the connection, found nothing, and wrote a
  // second version 1 with no predecessor.
  it("reads the workspace's latest version of the repository through any connection", async () => {
    const { tx: t, writes } = tx({ latest: [] });
    await writeRepositoryHead(t, args("linked"));
    if (writes.where === undefined) throw new Error("the writer read nothing");
    expect(new PgDialect().sqlToQuery(writes.where).params).toEqual([
      "org_1",
      "ws_1",
      "github",
      "9001",
    ]);
  });

  it("supersedes a version another connection holds, so a relink through a replacement connection continues the lineage", async () => {
    const { tx: t, writes } = tx({
      latest: [{ ...LATEST, connectionId: "conn-retired", version: 2 }],
      inserted: [{ id: "binding-3", publicId: "rpb_third" }],
    });
    const out = await writeRepositoryHead(t, args("linked"));

    const binding = writes.inserts.find(
      (w) => w.table === schema.repositoryBindings,
    );
    // Nothing the version records moved, but its connection did: the new
    // version names the replacement connection and its predecessor.
    expect(binding?.values).toMatchObject({
      connectionId: "conn-uuid",
      version: 3,
      supersedesBindingId: "binding-1",
    });
    const head = writes.inserts.find(
      (w) => w.table === schema.repositoryBindingHeads,
    );
    expect(head?.values).toMatchObject({
      connectionId: "conn-uuid",
      currentBindingId: "binding-3",
    });
    expect(out).toEqual({ bindingPublicId: "rpb_third" });
  });

  it("supersedes on a rename too, carrying every renamed field together", async () => {
    const { tx: t, writes } = tx({
      latest: [
        {
          ...LATEST,
          providerOwner: "OldOrg",
          providerName: "OldName",
          providerFullName: "OldOrg/OldName",
        },
      ],
    });
    await writeRepositoryHead(t, args("steering"));
    const binding = writes.inserts.find(
      (w) => w.table === schema.repositoryBindings,
    );
    expect(binding?.values).toMatchObject({
      version: 2,
      supersedesBindingId: "binding-1",
      providerOwner: "Acme",
      providerName: "Widgets",
      providerFullName: "Acme/Widgets",
    });
  });

  it("throws when the bindings insert returns no row, before any head is written", async () => {
    const { tx: t, writes } = tx({ latest: [], inserted: [] });
    await expect(writeRepositoryHead(t, args("steering"))).rejects.toThrow(
      "repository_bindings insert returned no row",
    );
    expect(
      writes.inserts.filter((w) => w.table === schema.repositoryBindingHeads),
    ).toHaveLength(0);
  });
});

// The link reads one repository, so its token reaches that repository alone,
// with the metadata read the repository GET needs (#4753). The real mint runs
// in front of a fake api.github.com that records the request body.
describe("githubMainRepositoryDeps.repository", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function app() {
    vi.stubEnv("GITHUB_APP_ID", "101");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", TEST_APP_PRIVATE_KEY);
  }

  it("asks for a token for the named repository with metadata read only", async () => {
    app();
    const github = githubTokenFetch({
      routes: {
        "/repos/Acme/Widgets": {
          id: 9001,
          owner: { login: "Acme" },
          name: "Widgets",
          full_name: "Acme/Widgets",
          html_url: "https://github.com/Acme/Widgets",
          default_branch: "trunk",
        },
      },
    });
    vi.stubGlobal("fetch", github.fetch);
    await expect(
      githubMainRepositoryDeps.repository("47541", "Acme", "Widgets"),
    ).resolves.toEqual(REPO);
    expect(github.mints).toEqual([
      {
        installationId: "47541",
        body: { repositories: ["Widgets"], permissions: { metadata: "read" } },
      },
    ]);
  });

  it("answers null, and reads nothing, when GitHub will not mint for the repository", async () => {
    app();
    const github = githubTokenFetch({
      mintStatus: 422,
      mintMessage:
        "There is at least one repository that does not exist or is not accessible to the parent installation.",
    });
    vi.stubGlobal("fetch", github.fetch);
    await expect(
      githubMainRepositoryDeps.repository("47542", "Acme", "Widgets"),
    ).resolves.toBeNull();
    expect(github.requests).toEqual([
      "POST /app/installations/47542/access_tokens",
    ]);
  });

  it("lets any other mint failure through", async () => {
    app();
    vi.stubGlobal(
      "fetch",
      githubTokenFetch({ mintStatus: 401, mintMessage: "Bad credentials" })
        .fetch,
    );
    await expect(
      githubMainRepositoryDeps.repository("47543", "Acme", "Widgets"),
    ).rejects.toThrow("GitHub App token mint failed (401): Bad credentials");
  });
});
