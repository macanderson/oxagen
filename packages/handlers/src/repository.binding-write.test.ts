// The one writer of a NEW binding head, shared by `create_workspace` and
// `link_repository`. What it has to get right is the version chain against
// `repository_bindings_repository_version_uq` on (connection, repository,
// version): a repository this connection bound before already HAS a version 1,
// so a second one would violate the index. Three cases, one per test.
import { describe, expect, it } from "vitest";
import type { GitHubRepoInfo } from "@oxagen/github";
import { schema, type Tx } from "@oxagen/database";
import { writeRepositoryHead } from "./repository.binding-write";

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
  version: 1,
  providerOwner: REPO.owner,
  providerName: REPO.name,
  providerFullName: REPO.fullName,
  configuredDefaultRef: REPO.defaultBranch,
};

interface Writes {
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
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
        where: () => ({
          orderBy: () => ({ limit: async () => opts.latest ?? [] }),
        }),
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

const args = (role: "main" | "linked") => ({
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
    const out = await writeRepositoryHead(t, args("main"));

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
      role: "main",
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
    await writeRepositoryHead(t, args("main"));
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
    await expect(writeRepositoryHead(t, args("main"))).rejects.toThrow(
      "repository_bindings insert returned no row",
    );
    expect(
      writes.inserts.filter((w) => w.table === schema.repositoryBindingHeads),
    ).toHaveLength(0);
  });
});
