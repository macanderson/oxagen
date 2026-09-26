// `unbound_repo` on the bundle (#3941): the digests the host compares its
// remote against, when the clause is sent, and the reads it is built from.
import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { schema, type Tx } from "@oxagen/database";
import {
  canonicalRemote,
  digestBytes,
  foldedRemote,
  policyBundleSchema,
} from "@oxagen/tacho";
import { SKILL_INTERJECTION_TIMEOUT_MS } from "@oxagen/oxagen/skills";
import type { UnboundRepoReads as Reads } from "./tacho-unbound-repo";

vi.mock("../logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const {
  boundRemoteDigests,
  POSTGRES_UNBOUND_REPO_READS,
  resolveUnboundRepo,
} = await import("./tacho-unbound-repo");

const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const dialect = new PgDialect();

/** What the host seals for a remote: its canonical and folded digests. */
function hostDigests(remote: string): { canonical: string; folded: string } {
  const canonical = canonicalRemote(remote);
  return {
    canonical: digestBytes(canonical),
    folded: digestBytes(foldedRemote(canonical)),
  };
}

describe("the bound digests match what the host computes from its remote", () => {
  const digests = boundRemoteDigests([
    { provider: "github", fullName: "Acme/Repo" },
  ]);

  it.each([
    ["an scp remote", "git@github.com:Acme/Repo.git"],
    ["an https remote", "https://github.com/Acme/Repo.git"],
    [
      "a remote carrying a token",
      "https://x-access-token:ghs_secret@github.com/Acme/Repo.git?x=1",
    ],
    ["an ssh URL", "ssh://git@github.com/Acme/Repo"],
  ])("%s", (_name, remote) => {
    const host = hostDigests(remote);
    expect(digests).toContain(host.canonical);
    expect(digests).toContain(host.folded);
  });

  it("matches a remote typed in another case through the folded digest", () => {
    // GitHub serves Acme/Repo and acme/repo from one repository. The host's
    // canonical digest of the lowercase remote differs, the folded one not.
    const host = hostDigests("git@github.com:acme/repo.git");
    expect(digests).not.toContain(host.canonical);
    expect(digests).toContain(host.folded);
  });

  it("digests a GitLab project on gitlab.com, subgroups included", () => {
    const host = hostDigests("git@gitlab.com:group/sub/project.git");
    expect(
      boundRemoteDigests([
        { provider: "gitlab", fullName: "group/sub/project" },
      ]),
    ).toContain(host.canonical);
  });

  it("does not match another repository (negative)", () => {
    const host = hostDigests("git@github.com:Acme/Other.git");
    expect(digests).not.toContain(host.canonical);
    expect(digests).not.toContain(host.folded);
  });

  it("is sorted and holds each digest once, so the etag does not move with row order", () => {
    const a = { provider: "github", fullName: "acme/api" };
    const b = { provider: "github", fullName: "Acme/Web" };
    const once = boundRemoteDigests([a, b]);
    expect(boundRemoteDigests([b, a, a])).toEqual(once);
    expect(once).toEqual([...once].sort());
    // acme/api folds onto itself, so it adds one digest; Acme/Web adds two.
    expect(once).toHaveLength(3);
  });
});

/** Reads that answer from fixed values and record which ran. */
function reads(over: Partial<Reads> = {}): Reads & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    skillsHead: async () => {
      calls.push("skillsHead");
      return { versionLabel: "skl_v3", enabled: true, pinned: 4 };
    },
    workspaceSlug: async () => {
      calls.push("workspaceSlug");
      return "payments";
    },
    linkedRepositories: async () => {
      calls.push("linkedRepositories");
      return 2;
    },
    boundRepositories: async () => {
      calls.push("boundRepositories");
      return [{ provider: "github", fullName: "acme/payments" }];
    },
    ...over,
  };
}

const TX = {} as Tx;

describe("resolveUnboundRepo", () => {
  it("builds the clause the host parses: ask, thirty minutes, the slug, the version and the link facts", async () => {
    const clause = await resolveUnboundRepo(TX, SCOPE, true, reads());
    expect(clause).toEqual({
      policy: "ask",
      timeout_ms: SKILL_INTERJECTION_TIMEOUT_MS,
      workspace_slug: "payments",
      config_version: "skl_v3",
      bound_remote_digests: boundRemoteDigests([
        { provider: "github", fullName: "acme/payments" },
      ]),
      link: { skills_pinned: 4, linked_repositories: 2 },
    });
    expect(SKILL_INTERJECTION_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(
      policyBundleSchema.shape.unbound_repo.unwrap().parse(clause),
    ).toEqual(clause);
  });

  it("asks nothing, and reads nothing, for a host that did not advertise the field", async () => {
    const r = reads();
    expect(await resolveUnboundRepo(TX, SCOPE, false, r)).toBeUndefined();
    expect(r.calls).toEqual([]);
  });

  it("sends no clause when the workspace's skills are off, and reads no bindings", async () => {
    const r = reads({
      skillsHead: async () => ({
        versionLabel: "skl_v1",
        enabled: false,
        pinned: 0,
      }),
    });
    expect(await resolveUnboundRepo(TX, SCOPE, true, r)).toBeUndefined();
    expect(r.calls).not.toContain("boundRepositories");
  });

  it("sends no clause when the workspace has published no configuration", async () => {
    const r = reads({ skillsHead: async () => undefined });
    expect(await resolveUnboundRepo(TX, SCOPE, true, r)).toBeUndefined();
  });

  it("drops a clause the host's strict schema would refuse, rather than strand the host (negative)", async () => {
    const r = reads({ workspaceSlug: async () => "x".repeat(65) });
    expect(await resolveUnboundRepo(TX, SCOPE, true, r)).toBeUndefined();
  });
});

/**
 * A transaction that answers each select with the rows `answers` holds for
 * its table and records what each select asked: its joins, its filter, and
 * whether the organisation-wide read was on when it ran.
 */
function fakeTx(answers: Map<unknown, unknown[]>) {
  let orgWide = "off";
  const asked: Array<{
    table: unknown;
    joins: SQL[];
    where: SQL | null;
    orgWide: string;
    ordered: boolean;
  }> = [];
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        const query = {
          table,
          joins: [] as SQL[],
          where: null as SQL | null,
          orgWide,
          ordered: false,
        };
        asked.push(query);
        const chain = {
          innerJoin: (_joined: unknown, on: SQL) => {
            query.joins.push(on);
            return chain;
          },
          where: (condition: SQL) => {
            query.where = condition;
            return chain;
          },
          orderBy: () => {
            query.ordered = true;
            return chain;
          },
          limit: () => chain,
          then: (
            resolve: (rows: unknown[]) => unknown,
            reject: (error: unknown) => unknown,
          ) => Promise.resolve(answers.get(table) ?? []).then(resolve, reject),
        };
        return chain;
      },
    }),
    execute: vi.fn(async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      if (compiled.sql.includes("current_setting"))
        return [{ org_wide: orgWide }];
      orgWide = compiled.params.length ? String(compiled.params[0]) : "on";
      return [];
    }),
    transaction: vi.fn(async (fn: (inner: Tx) => Promise<unknown>) =>
      fn(tx as unknown as Tx),
    ),
  };
  return { tx: tx as unknown as Tx, asked, orgWide: () => orgWide };
}

const text = (condition: SQL | null) =>
  condition === null ? "" : dialect.sqlToQuery(condition).sql;

describe("the reads behind the clause", () => {
  it("reads every workspace's bindings with the organisation-wide read on, then turns it off", async () => {
    const { tx, asked, orgWide } = fakeTx(
      new Map([
        [
          schema.repositoryBindingHeads,
          [{ provider: "github", fullName: "acme/other-team" }],
        ],
      ]),
    );
    const rows = await POSTGRES_UNBOUND_REPO_READS.boundRepositories(
      tx,
      SCOPE,
    );
    expect(rows).toEqual([{ provider: "github", fullName: "acme/other-team" }]);
    const [read] = asked;
    expect(read?.orgWide).toBe("on");
    expect(orgWide()).toBe("off");
    // The organisation is fenced, and no workspace is: another workspace's
    // main or linked repository is bound too.
    expect(text(read?.where ?? null)).toContain('"org_id" = $');
    expect(text(read?.where ?? null)).not.toContain('"workspace_id"');
  });

  it("takes the newest version under the workspace's current main repository", async () => {
    const { tx, asked } = fakeTx(
      new Map([
        [
          schema.skillConfigVersions,
          [
            {
              versionLabel: "skl_v2",
              enabled: true,
              sources: [
                { id: "main", path: ".oxagen/skills", skills: [{}, {}] },
                { id: "more", path: ".oxagen/skills", skills: [{}] },
              ],
            },
          ],
        ],
      ]),
    );
    expect(await POSTGRES_UNBOUND_REPO_READS.skillsHead(tx, SCOPE)).toEqual({
      versionLabel: "skl_v2",
      enabled: true,
      pinned: 3,
    });
    const [read] = asked;
    expect(read?.orgWide).toBe("off");
    expect(read?.ordered).toBe(true);
    const join = text(read?.joins[0] ?? null);
    expect(join).toContain('"current_binding_id"');
    expect(join).toContain('"role" = $');
  });

  it("counts the workspace's linked repositories", async () => {
    const { tx, asked } = fakeTx(
      new Map([[schema.repositoryBindingHeads, [{ linked: 5 }]]]),
    );
    expect(
      await POSTGRES_UNBOUND_REPO_READS.linkedRepositories(tx, SCOPE),
    ).toBe(5);
    expect(text(asked[0]?.where ?? null)).toContain('"workspace_id" = $');
  });
});
