// repository.link.reconcile.ts moves the linked heads to follow the list in
// workspace.toml (ADR-212). This suite runs the reconcile against a head table
// held in memory. The database, the head writer and the workspace lock are
// seams, so each test can say what the reconcile read, deleted and wrote, and
// in what order. repository.pg.test.ts runs the same module against Postgres.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  linkRepositoryHead: vi.fn(),
  lock: vi.fn((workspaceId: string) => ({ lockFor: workspaceId })),
  githubDeps: { repository: vi.fn() },
  logInfo: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

// The filters come back as plain objects, so the fake transaction can read
// which workspace a query asked for and which ids a delete named.
vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...real,
    and: (...args: unknown[]) => ({ __and: args }),
    eq: (col: unknown, val: unknown) => ({ __eq: [col, val] }),
    inArray: (col: unknown, values: unknown) => ({ __inArray: [col, values] }),
  };
});

vi.mock("./repository.main.bind", () => ({
  githubMainRepositoryDeps: mocks.githubDeps,
  workspaceRepositoriesLock: mocks.lock,
}));

vi.mock("./repository.link.write", () => ({
  linkRepositoryHead: mocks.linkRepositoryHead,
}));

vi.mock("./logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./logger")>()),
  logger: { info: mocks.logInfo, warn: vi.fn(), error: vi.fn() },
}));

import { schema } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import { repoRef } from "@oxagen/oxagen/steering-repo/names";
import { WORKSPACE_TOML_PATH } from "@oxagen/oxagen/steering-repo/paths";
import {
  createLinkReconciler,
  type LinkChange,
  reconcileWorkspaceLinks,
} from "./repository.link.reconcile";
import type { MainRepositoryDeps } from "./repository.main.bind";
import { githubRepoRef, splitRepoRef } from "./repository.workspace-toml";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const OTHER_WS = "00000000-0000-4000-8000-000000000003";
const SCOPE = { orgId: ORG, workspaceId: WS };
const NOW = new Date("2026-09-27T12:00:00.000Z");
const LATER = new Date("2026-09-27T13:00:00.000Z");
const DEPS: Pick<MainRepositoryDeps, "repository"> = { repository: vi.fn() };

interface Repo {
  owner: string;
  name: string;
}

// GitHub's own spelling. workspace.toml lists each one in lowercase.
const API: Repo = { owner: "Acme", name: "Api" };
const WEB: Repo = { owner: "Acme", name: "Web" };
const DOCS: Repo = { owner: "Acme", name: "Docs" };
const STEERING: Repo = { owner: "Acme", name: "Steering" };
const KNOWN = [API, WEB, DOCS, STEERING];

const refOf = (repo: Repo): string => githubRepoRef(repo.owner, repo.name);
const fullNameOf = (repo: Repo): string => `${repo.owner}/${repo.name}`;

interface Head {
  id: string;
  orgId: string;
  workspaceId: string;
  role: string;
  provider: string;
  owner: string;
  name: string;
  fullName: string;
}

interface Condition {
  __and?: unknown[];
  __eq?: [unknown, unknown];
  __inArray?: [unknown, unknown];
}

const db = {
  heads: [] as Head[],
  events: [] as string[],
  locks: [] as unknown[],
  deleted: [] as string[],
  nextId: 0,
};

function nextHeadId(): string {
  db.nextId += 1;
  return `head-${db.nextId}`;
}

function seed(
  repo: Repo,
  role: "steering" | "linked",
  opts: { workspaceId?: string; provider?: string } = {},
): string {
  const id = nextHeadId();
  db.heads.push({
    id,
    orgId: ORG,
    workspaceId: opts.workspaceId ?? WS,
    role,
    provider: opts.provider ?? "github",
    owner: repo.owner,
    name: repo.name,
    fullName: fullNameOf(repo),
  });
  return id;
}

/** The value an `eq` on `column` names, inside an `and` or on its own. */
function eqValue(cond: unknown, column: unknown): unknown {
  const top = cond as Condition;
  for (const part of (top.__and ?? [top]) as Condition[])
    if (part.__eq && part.__eq[0] === column) return part.__eq[1];
  throw new Error("the head read has no filter on that column");
}

const tx = {
  execute: async (query: unknown) => {
    db.locks.push(query);
    db.events.push("lock");
    return [];
  },
  select: (_fields: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      innerJoin: (joined: unknown, _on: unknown) => ({
        where: async (cond: unknown) => {
          expect(table).toBe(schema.repositoryBindingHeads);
          expect(joined).toBe(schema.repositoryBindings);
          const orgId = eqValue(cond, schema.repositoryBindingHeads.orgId);
          const workspaceId = eqValue(
            cond,
            schema.repositoryBindingHeads.workspaceId,
          );
          return db.heads
            .filter((h) => h.orgId === orgId && h.workspaceId === workspaceId)
            .map(({ id, role, provider, owner, name, fullName }) => ({
              id,
              role,
              provider,
              owner,
              name,
              fullName,
            }));
        },
      }),
    }),
  }),
  delete: (table: unknown) => ({
    where: async (cond: unknown) => {
      expect(table).toBe(schema.repositoryBindingHeads);
      const filter = (cond as Condition).__inArray;
      if (!filter) throw new Error("the delete names no id list");
      const [column, values] = filter;
      expect(column).toBe(schema.repositoryBindingHeads.id);
      const ids = values as string[];
      db.deleted.push(...ids);
      db.events.push(`delete:${ids.join(",")}`);
      db.heads = db.heads.filter((h) => !ids.includes(h.id));
    },
  }),
};

/**
 * The head writer as the reconcile sees it: it finds the repository on
 * GitHub whatever the case, writes a linked head, and answers with GitHub's
 * full name.
 */
async function linkInMemory(
  scope: { orgId: string; workspaceId: string },
  repository: { owner: string; name: string },
): Promise<{ bindingPublicId: string; fullName: string }> {
  const repo = KNOWN.find(
    (r) =>
      r.owner.toLowerCase() === repository.owner.toLowerCase() &&
      r.name.toLowerCase() === repository.name.toLowerCase(),
  );
  if (!repo)
    throw new Error(
      `the test knows no repository ${repository.owner}/${repository.name}`,
    );
  const id = nextHeadId();
  db.heads.push({
    id,
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    role: "linked",
    provider: "github",
    owner: repo.owner,
    name: repo.name,
    fullName: fullNameOf(repo),
  });
  db.events.push(`link:${fullNameOf(repo)}`);
  return { bindingPublicId: `rpb_${id}`, fullName: fullNameOf(repo) };
}

const change = (
  prior: string[] | null,
  current: string[],
  now: Date = NOW,
): LinkChange => ({ prior, current, now });

const reconcile = createLinkReconciler(DEPS);

beforeEach(() => {
  db.heads = [];
  db.events = [];
  db.locks = [];
  db.deleted = [];
  db.nextId = 0;
  mocks.withTenantDb.mockReset();
  mocks.withTenantDb.mockImplementation(
    async (fn: (t: typeof tx) => unknown) => fn(tx),
  );
  mocks.linkRepositoryHead.mockReset();
  mocks.linkRepositoryHead.mockImplementation(linkInMemory);
});

describe("createLinkReconciler", () => {
  it("unlinks a dropped entry and links an added one in one call", async () => {
    seed(STEERING, "steering");
    const docs = seed(DOCS, "linked");

    const result = await reconcile(SCOPE, change([refOf(DOCS)], [refOf(API)]));

    expect(result).toEqual({
      linked: [fullNameOf(API)],
      unlinked: [fullNameOf(DOCS)],
      findings: [],
    });
    const { owner, name } = splitRepoRef(refOf(API));
    expect(mocks.linkRepositoryHead).toHaveBeenCalledTimes(1);
    expect(mocks.linkRepositoryHead).toHaveBeenCalledWith(
      SCOPE,
      { owner, name },
      { userId: null, now: NOW },
      DEPS,
    );
    expect(mocks.lock).toHaveBeenCalledWith(WS);
    expect(db.locks).toEqual([{ lockFor: WS }]);
    expect(db.deleted).toEqual([docs]);
    expect(db.heads.map((h) => h.fullName)).toEqual([
      fullNameOf(STEERING),
      fullNameOf(API),
    ]);
    expect(mocks.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        ...SCOPE,
        linked: [fullNameOf(API)],
        unlinked: [fullNameOf(DOCS)],
        findings: 0,
      }),
      expect.any(String),
    );
  });

  it("deletes the dropped head under the lock before it links the first new one", async () => {
    const web = seed(WEB, "linked");

    await reconcile(SCOPE, change([refOf(WEB)], [refOf(API), refOf(DOCS)]));

    expect(db.events).toEqual([
      "lock",
      `delete:${web}`,
      `link:${fullNameOf(API)}`,
      `link:${fullNameOf(DOCS)}`,
    ]);
  });

  describe("running again", () => {
    it("changes nothing when the next head lists what the first run linked", async () => {
      seed(STEERING, "steering");
      seed(DOCS, "linked");
      const first = await reconcile(
        SCOPE,
        change([refOf(DOCS)], [refOf(API), refOf(WEB)]),
      );
      expect(first).toEqual({
        linked: [fullNameOf(API), fullNameOf(WEB)],
        unlinked: [fullNameOf(DOCS)],
        findings: [],
      });
      mocks.linkRepositoryHead.mockClear();
      mocks.lock.mockClear();
      mocks.logInfo.mockClear();
      db.events = [];
      db.locks = [];
      db.deleted = [];
      const heads = db.heads.map((h) => ({ ...h }));

      const second = await reconcile(
        SCOPE,
        change([refOf(API), refOf(WEB)], [refOf(API), refOf(WEB)], LATER),
      );

      expect(second).toEqual({ linked: [], unlinked: [], findings: [] });
      expect(mocks.linkRepositoryHead).not.toHaveBeenCalled();
      expect(mocks.lock).not.toHaveBeenCalled();
      expect(db.locks).toEqual([]);
      expect(db.deleted).toEqual([]);
      expect(db.events).toEqual([]);
      expect(db.heads).toEqual(heads);
      expect(mocks.logInfo).not.toHaveBeenCalled();
    });

    it("changes nothing when the same change runs twice", async () => {
      seed(STEERING, "steering");
      seed(DOCS, "linked");
      const same = change([refOf(DOCS)], [refOf(API), refOf(WEB)]);
      await reconcile(SCOPE, same);
      mocks.linkRepositoryHead.mockClear();
      mocks.logInfo.mockClear();
      db.events = [];
      db.deleted = [];
      const heads = db.heads.map((h) => ({ ...h }));

      const second = await reconcile(SCOPE, same);

      expect(second).toEqual({ linked: [], unlinked: [], findings: [] });
      expect(mocks.linkRepositoryHead).not.toHaveBeenCalled();
      // The prior list still names a dropped entry, so the lock is taken. The
      // read under it finds that head already gone.
      expect(db.events).toEqual(["lock"]);
      expect(db.deleted).toEqual([]);
      expect(db.heads).toEqual(heads);
      expect(mocks.logInfo).not.toHaveBeenCalled();
    });
  });

  describe("removals", () => {
    it("keeps a linked head that the prior list never named", async () => {
      const docs = seed(DOCS, "linked");
      const web = seed(WEB, "linked");
      const api = seed(API, "linked");

      const result = await reconcile(
        SCOPE,
        change([refOf(WEB), refOf(API)], [refOf(API)]),
      );

      expect(result).toEqual({
        linked: [],
        unlinked: [fullNameOf(WEB)],
        findings: [],
      });
      expect(db.deleted).toEqual([web]);
      expect(db.heads.map((h) => h.id)).toEqual([docs, api]);
      expect(mocks.linkRepositoryHead).not.toHaveBeenCalled();
    });

    it("removes nothing when nobody can tell what the prior list held", async () => {
      seed(DOCS, "linked");
      seed(WEB, "linked");
      const heads = db.heads.map((h) => ({ ...h }));

      const result = await reconcile(SCOPE, change(null, []));

      expect(result).toEqual({ linked: [], unlinked: [], findings: [] });
      expect(mocks.lock).not.toHaveBeenCalled();
      expect(db.events).toEqual([]);
      expect(db.heads).toEqual(heads);
    });

    it("keeps the steering head when its entry drops", async () => {
      const steering = seed(STEERING, "steering");
      const docs = seed(DOCS, "linked");

      const result = await reconcile(
        SCOPE,
        change([refOf(STEERING), refOf(DOCS)], []),
      );

      expect(result.unlinked).toEqual([fullNameOf(DOCS)]);
      expect(db.deleted).toEqual([docs]);
      expect(db.heads.map((h) => h.id)).toEqual([steering]);
    });

    it("keeps a head on another host when a github.com entry with its owner and name drops", async () => {
      const { owner, name } = splitRepoRef(refOf(API));
      const gitlab = seed({ owner, name }, "linked", { provider: "gitlab" });

      const result = await reconcile(SCOPE, change([refOf(API)], []));

      expect(result).toEqual({ linked: [], unlinked: [], findings: [] });
      expect(db.events).toEqual(["lock"]);
      expect(db.deleted).toEqual([]);
      expect(db.heads.map((h) => h.id)).toEqual([gitlab]);
    });

    it("deletes only this workspace's head", async () => {
      const elsewhere = seed(DOCS, "linked", { workspaceId: OTHER_WS });
      const ours = seed(DOCS, "linked");

      const result = await reconcile(SCOPE, change([refOf(DOCS)], []));

      expect(result.unlinked).toEqual([fullNameOf(DOCS)]);
      expect(db.deleted).toEqual([ours]);
      expect(db.heads.map((h) => h.id)).toEqual([elsewhere]);
    });
  });

  describe("additions", () => {
    it("warns when workspace.toml lists the steering repository", async () => {
      seed(STEERING, "steering");

      const result = await reconcile(SCOPE, change(null, [refOf(STEERING)]));

      expect(result.findings).toEqual([
        {
          level: "warning",
          code: "repository_link",
          path: WORKSPACE_TOML_PATH,
          lineageId: null,
          message: expect.stringContaining(refOf(STEERING)),
        },
      ]);
      expect(result.linked).toEqual([]);
      expect(mocks.linkRepositoryHead).not.toHaveBeenCalled();
    });

    it("warns when workspace.toml lists a repository on another host", async () => {
      const gitlab = repoRef("gitlab.com", "acme", "x");

      const result = await reconcile(SCOPE, change(null, [gitlab]));

      expect(result.findings).toEqual([
        {
          level: "warning",
          code: "repository_link",
          path: WORKSPACE_TOML_PATH,
          lineageId: null,
          message: expect.stringContaining(gitlab),
        },
      ]);
      expect(result.linked).toEqual([]);
      expect(mocks.linkRepositoryHead).not.toHaveBeenCalled();
    });

    it("skips an entry that a concurrent write already linked", async () => {
      mocks.linkRepositoryHead.mockRejectedValueOnce(
        new HandlerError({
          code: "conflict",
          reason: "repository_already_linked",
          message: `${fullNameOf(API)} is already linked to this workspace`,
        }),
      );

      const result = await reconcile(SCOPE, change(null, [refOf(API)]));

      expect(result).toEqual({ linked: [], unlinked: [], findings: [] });
      expect(mocks.linkRepositoryHead).toHaveBeenCalledTimes(1);
      expect(mocks.logInfo).not.toHaveBeenCalled();
    });

    it("warns about a repository it cannot link and goes on to the next entry", async () => {
      mocks.linkRepositoryHead.mockRejectedValueOnce(
        new HandlerError({
          code: "not_found",
          reason: "repository_not_installed",
          message: `The GitHub App installation on this workspace cannot see ${fullNameOf(API)}`,
        }),
      );

      const result = await reconcile(
        SCOPE,
        change(null, [refOf(API), refOf(WEB)]),
      );

      expect(result.linked).toEqual([fullNameOf(WEB)]);
      expect(result.findings).toEqual([
        {
          level: "warning",
          code: "repository_link",
          path: WORKSPACE_TOML_PATH,
          lineageId: null,
          message: expect.stringContaining(refOf(API)),
        },
      ]);
      expect(result.findings[0]?.message).toContain("repository_not_installed");
      expect(mocks.linkRepositoryHead).toHaveBeenCalledTimes(2);
    });

    it("rejects with an error that is not a HandlerError", async () => {
      const boom = new Error("connection reset");
      mocks.linkRepositoryHead.mockRejectedValueOnce(boom);

      await expect(
        reconcile(SCOPE, change(null, [refOf(API), refOf(WEB)])),
      ).rejects.toBe(boom);
      expect(mocks.linkRepositoryHead).toHaveBeenCalledTimes(1);
    });
  });
});

describe("reconcileWorkspaceLinks", () => {
  it("links through the app's GitHub reader", async () => {
    await reconcileWorkspaceLinks(SCOPE, change(null, [refOf(API)]));

    expect(mocks.linkRepositoryHead).toHaveBeenCalledTimes(1);
    expect(mocks.linkRepositoryHead.mock.calls[0]?.[3]).toBe(mocks.githubDeps);
  });
});
