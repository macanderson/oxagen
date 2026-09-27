import { describe, expect, it, vi } from "vitest";
import { NotBuiltError, toolManifestSchema } from "@oxagen/mcp-studio";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import type { BundleIdentity } from "./build";
import {
  memoryVersionStore,
  publish,
  versionTag,
  type PublishDeps,
  type PublishResult,
} from "./publish";
import { treeFromFiles, type BlobCache } from "./tree";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const IDENTITY: BundleIdentity = {
  repository: "github.com/a-intel/oxagen-core-platform",
  scope: "workspace",
  organization: "a-intel",
  workspace: "core-platform",
};
const REPOSITORY = IDENTITY.repository;
const OTHER_REPOSITORY = "github.com/a-intel/oxagen";

const FIRST_COMMIT = "b5518188b20ddf02f905fadeaa50d9976abdcc90";
const SECOND_COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** A record in the fixture repo whose body the second merge changes. */
const PLAIN_WORDS = "steering/brand/a-intel.brand.plain-words.md";

const PROJECT_UNSET_WARNING =
  "The tool registry was not updated: MCP Studio's project() is not built yet.";
const PROJECT_NOT_BUILT_WARNING =
  "The tool registry was not updated: MCP Studio's project is not built yet.";

type MemoryStore = ReturnType<typeof memoryVersionStore>;
type Published = Extract<PublishResult, { status: "published" }>;

/** MCP Studio's compile() stands here, so no server compiles and the tool manifest stays null. */
function refuseCompile(): never {
  throw new NotBuiltError("compile");
}

/**
 * Deps over the fixture repo, with spies on the head, the tree, and the tag.
 * The branch head starts at FIRST_COMMIT, and `moveHead` moves it.
 */
function setup(
  overrides: Partial<Omit<PublishDeps, "store">> = {},
  store: MemoryStore = memoryVersionStore(),
) {
  let branchHead = FIRST_COMMIT;
  const head = vi.fn<PublishDeps["head"]>(async () => branchHead);
  const tag = vi.fn<PublishDeps["tag"]>(async () => undefined);
  const tree = vi.fn<PublishDeps["tree"]>(async () => treeFromFiles(fixtureRepo()));
  const deps: PublishDeps = {
    store,
    health: async () => "healthy",
    head,
    tree,
    tag,
    compiler: refuseCompile,
    now: () => new Date("2026-09-24T10:00:30Z"),
    ...overrides,
  };
  const moveHead = (commit: string): void => {
    branchHead = commit;
  };
  return { deps, store, tag, tree, head, moveHead };
}

/** Make the store's next `setPublished` reject with `failure`. The one after works. */
function failNextSetPublished(store: MemoryStore, failure: Error): MemoryStore {
  const inner = store.setPublished.bind(store);
  let failNext = true;
  store.setPublished = (repository, pointer) => {
    if (failNext) {
      failNext = false;
      return Promise.reject(failure);
    }
    return inner(repository, pointer);
  };
  return store;
}

function published(result: PublishResult): Published {
  if (result.status !== "published") {
    throw new Error(`The publish ended ${result.status}, not published.`);
  }
  return result;
}

/** The fixture repo with one more line in the plain-words record's body. */
function changedRepo(): Map<string, string> {
  const files = fixtureRepo();
  const text = files.get(PLAIN_WORDS);
  if (text === undefined) throw new Error(`${PLAIN_WORDS} is not in the fixture repo.`);
  files.set(PLAIN_WORDS, `${text}\nKeep each sentence under 25 words.\n`);
  return files;
}

function isRegistryWarning(warning: string): boolean {
  return warning.startsWith("The tool registry was not updated");
}

/** The server folders under tools/servers/ in the fixture repo. */
const FIXTURE_FOLDERS = ["billing", "stripe"];

/** The fixture repo with one more server folder, zeta. */
function repoWithZeta(): Map<string, string> {
  const files = fixtureRepo();
  files.set("tools/servers/zeta/server.toml", 'name = "zeta"\n');
  files.set("tools/servers/zeta/tools.toml", "");
  return files;
}

// ── versionTag ───────────────────────────────────────────────────────────────

describe("versionTag", () => {
  it("names the tag steering/<number>", () => {
    expect(versionTag(7)).toBe("steering/7");
    expect(versionTag(1)).toBe("steering/1");
  });
});

// ── publish ──────────────────────────────────────────────────────────────────

describe("publish", () => {
  it.each(["drifted", "disconnected", "diverged"] as const)(
    "refuses to publish while the repository is %s",
    async (health) => {
      const { deps, store, tag, tree } = setup({ health: async () => health });

      const result = await publish(deps, IDENTITY, FIRST_COMMIT);

      expect(result).toEqual({ status: "refused", health });
      expect(store.versions.size).toBe(0);
      expect(store.published.size).toBe(0);
      expect(await store.current(REPOSITORY)).toBeNull();
      expect(tree).not.toHaveBeenCalled();
      expect(tag).not.toHaveBeenCalled();
    },
  );

  it("publishes the first merge as version 1 and tags its commit", async () => {
    const { deps, store, tag, tree, head } = setup();

    const result = published(await publish(deps, IDENTITY, FIRST_COMMIT));

    expect(result.version).toBe(1);
    expect(result.commit).toBe(FIRST_COMMIT);
    expect(result.tag).toBe("steering/1");
    expect(head).toHaveBeenCalledWith(REPOSITORY);
    expect(tree).toHaveBeenCalledWith(REPOSITORY, FIRST_COMMIT);
    expect(tag).toHaveBeenCalledTimes(1);
    expect(tag).toHaveBeenCalledWith(REPOSITORY, "steering/1", FIRST_COMMIT);

    expect(result.bundle.repository).toBe(REPOSITORY);
    expect(result.bundle.version).toBe(1);
    expect(result.bundle.commit).toBe(FIRST_COMMIT);
    expect(result.bundle.published_at).toBe("2026-09-24T10:00:30.000Z");

    expect(await store.current(REPOSITORY)).toBe(result.bundle);
    expect(store.published.get(REPOSITORY)).toEqual({
      version: 1,
      commit: FIRST_COMMIT,
      ledger: result.bundle.ledger,
    });
    expect(result.warnings).toContain(PROJECT_UNSET_WARNING);
    expect(result.reads).toBeGreaterThan(0);
  });

  it("compiles each server with MCP Studio's compile() when no compiler is set", async () => {
    const { deps } = setup({ compiler: undefined });

    const result = published(await publish(deps, IDENTITY, FIRST_COMMIT));

    const manifest = toolManifestSchema.parse(result.bundle.tools);
    expect(manifest.servers.map((server) => server.name)).toEqual(FIXTURE_FOLDERS);
    expect(result.warnings.filter((warning) => warning.startsWith("tools/servers/"))).toEqual([]);
  });

  it("changes nothing when the published commit is published again", async () => {
    const { deps, store, tag, tree } = setup();
    published(await publish(deps, IDENTITY, FIRST_COMMIT));

    const again = await publish(deps, IDENTITY, FIRST_COMMIT);

    expect(again).toEqual({ status: "current", version: 1, commit: FIRST_COMMIT });
    expect(tag).toHaveBeenCalledTimes(1);
    expect(tree).toHaveBeenCalledTimes(1);
    expect(store.versions.get(REPOSITORY)?.map((bundle) => bundle.version)).toEqual([1]);
  });

  it("publishes a second merge as version 2 and fetches only the changed file", async () => {
    const trees = new Map<string, Map<string, string>>([
      [FIRST_COMMIT, fixtureRepo()],
      [SECOND_COMMIT, changedRepo()],
    ]);
    const cache: BlobCache = new Map<string, string>();
    const { deps, store, tag, moveHead } = setup({
      cache,
      tree: async (_repository, commit) => {
        const files = trees.get(commit);
        if (files === undefined) throw new Error(`No tree for ${commit}.`);
        return treeFromFiles(files);
      },
    });

    const first = published(await publish(deps, IDENTITY, FIRST_COMMIT));
    moveHead(SECOND_COMMIT);
    const second = published(await publish(deps, IDENTITY, SECOND_COMMIT));

    expect(second.version).toBe(2);
    expect(second.commit).toBe(SECOND_COMMIT);
    expect(second.tag).toBe("steering/2");
    expect(tag).toHaveBeenLastCalledWith(REPOSITORY, "steering/2", SECOND_COMMIT);

    // The previous version and the cache hold every other file's blob.
    expect(second.reads).toBeLessThan(first.reads);
    expect(second.reads).toBe(1);

    expect(await store.current(REPOSITORY)).toBe(second.bundle);
    expect(store.versions.get(REPOSITORY)?.map((bundle) => bundle.version)).toEqual([1, 2]);
  });

  it("adds no registry warning when project() updates the registry", async () => {
    const project = vi.fn<NonNullable<PublishDeps["project"]>>(async () => undefined);
    const { deps } = setup({ project });

    const result = published(await publish(deps, IDENTITY, FIRST_COMMIT));

    expect(project).toHaveBeenCalledTimes(1);
    expect(project).toHaveBeenCalledWith(result.bundle, { folders: FIXTURE_FOLDERS });
    expect(result.warnings.filter(isRegistryWarning)).toEqual([]);
  });

  it("names every server folder to project(), including servers that did not compile", async () => {
    const project = vi.fn<NonNullable<PublishDeps["project"]>>(async () => undefined);
    const { deps } = setup({ project });

    const result = published(await publish(deps, IDENTITY, FIRST_COMMIT));

    expect(result.bundle.tools).toBeNull();
    expect(project.mock.calls[0]?.[1]).toEqual({ folders: FIXTURE_FOLDERS });
  });

  it("publishes with a warning when project() is not built", async () => {
    const { deps, store } = setup({
      project: async () => {
        throw new NotBuiltError("project");
      },
    });

    const result = published(await publish(deps, IDENTITY, FIRST_COMMIT));

    expect(result.warnings).toContain(PROJECT_NOT_BUILT_WARNING);
    expect(result.warnings).not.toContain(PROJECT_UNSET_WARNING);
    expect(await store.current(REPOSITORY)).toBe(result.bundle);
  });

  it("publishes nothing when project() fails for another reason", async () => {
    const failure = new Error("The registry refused the write.");
    const { deps, store, tag } = setup({
      project: async () => {
        throw failure;
      },
    });

    await expect(publish(deps, IDENTITY, FIRST_COMMIT)).rejects.toBe(failure);

    expect(store.versions.size).toBe(0);
    expect(store.published.size).toBe(0);
    expect(tag).not.toHaveBeenCalled();
  });

  it("keeps the version published when the tag is not written", async () => {
    const { deps, store } = setup({
      tag: async () => {
        throw new Error("the host refused the tag");
      },
    });

    const result = published(await publish(deps, IDENTITY, FIRST_COMMIT));

    expect(result.version).toBe(1);
    expect(result.tag).toBeNull();
    expect(result.warnings).toContain(
      "Version 1 is published, but the tag steering/1 was not written: the host refused the tag",
    );
    expect(await store.current(REPOSITORY)).toBe(result.bundle);
  });

  it("never reuses a number that was stored and not published", async () => {
    const store = failNextSetPublished(memoryVersionStore(), new Error("The pointer write failed."));
    const { deps, tag } = setup({}, store);

    await expect(publish(deps, IDENTITY, FIRST_COMMIT)).rejects.toThrow(
      "The pointer write failed.",
    );
    expect(store.versions.get(REPOSITORY)?.map((bundle) => bundle.version)).toEqual([1]);
    expect(store.published.size).toBe(0);
    expect(tag).not.toHaveBeenCalled();

    const retry = published(await publish(deps, IDENTITY, FIRST_COMMIT));

    expect(retry.version).toBe(2);
    expect(retry.tag).toBe("steering/2");
    expect(store.versions.get(REPOSITORY)?.map((bundle) => bundle.version)).toEqual([1, 2]);
    expect(store.published.get(REPOSITORY)?.version).toBe(2);
  });

  it("publishes one version when two syncs of the same head run at once", async () => {
    const { deps, store, tag } = setup();

    const [first, second] = await Promise.all([
      publish(deps, IDENTITY, FIRST_COMMIT),
      publish(deps, IDENTITY, FIRST_COMMIT),
    ]);

    expect(published(first).version).toBe(1);
    expect(second).toEqual({ status: "current", version: 1, commit: FIRST_COMMIT });
    expect(store.versions.get(REPOSITORY)?.map((bundle) => bundle.version)).toEqual([1]);
    expect(tag).toHaveBeenCalledTimes(1);
  });

  it("does not publish a merge the branch has moved past", async () => {
    const { deps, store, tag, tree, moveHead } = setup();
    moveHead(SECOND_COMMIT);

    const result = await publish(deps, IDENTITY, FIRST_COMMIT);

    expect(result).toEqual({ status: "stale", commit: FIRST_COMMIT, head: SECOND_COMMIT });
    expect(store.versions.size).toBe(0);
    expect(store.published.size).toBe(0);
    expect(tree).not.toHaveBeenCalled();
    expect(tag).not.toHaveBeenCalled();
  });

  it("keeps the newer merge published when an older merge's sync finishes after it", async () => {
    // Syncs for FIRST_COMMIT and then SECOND_COMMIT start, and the second
    // finishes first. The first must not publish over it.
    const { deps, store, tag, moveHead } = setup();
    moveHead(SECOND_COMMIT);

    const newer = published(await publish(deps, IDENTITY, SECOND_COMMIT));
    const older = await publish(deps, IDENTITY, FIRST_COMMIT);

    expect(newer.version).toBe(1);
    expect(older).toEqual({ status: "stale", commit: FIRST_COMMIT, head: SECOND_COMMIT });
    expect(store.published.get(REPOSITORY)).toEqual({
      version: 1,
      commit: SECOND_COMMIT,
      ledger: newer.bundle.ledger,
    });
    expect(store.versions.get(REPOSITORY)?.map((bundle) => bundle.version)).toEqual([1]);
    expect(tag).toHaveBeenCalledTimes(1);
  });

  it("publishes only the head when two merges race under the publish lock", async () => {
    const { deps, store, moveHead } = setup();
    moveHead(SECOND_COMMIT);

    const [first, second] = await Promise.all([
      publish(deps, IDENTITY, FIRST_COMMIT),
      publish(deps, IDENTITY, SECOND_COMMIT),
    ]);

    expect(first).toEqual({ status: "stale", commit: FIRST_COMMIT, head: SECOND_COMMIT });
    expect(published(second).version).toBe(1);
    expect(store.published.get(REPOSITORY)?.commit).toBe(SECOND_COMMIT);
  });

  it("projects the published version back when the pointer write fails", async () => {
    const failure = new Error("The pointer write failed.");
    const store = memoryVersionStore();
    const project = vi.fn<NonNullable<PublishDeps["project"]>>(async () => undefined);
    const { deps, moveHead } = setup({ project }, store);
    const first = published(await publish(deps, IDENTITY, FIRST_COMMIT));

    failNextSetPublished(store, failure);
    moveHead(SECOND_COMMIT);

    await expect(publish(deps, IDENTITY, SECOND_COMMIT)).rejects.toBe(failure);

    expect(project.mock.calls.map(([bundle]) => bundle.version)).toEqual([1, 2, 1]);
    expect(project).toHaveBeenLastCalledWith(first.bundle, { folders: FIXTURE_FOLDERS });
    expect(await store.current(REPOSITORY)).toBe(first.bundle);
  });

  it("projects the published version back when the store refuses the version", async () => {
    const failure = new Error("The version write failed.");
    const store = memoryVersionStore();
    const project = vi.fn<NonNullable<PublishDeps["project"]>>(async () => undefined);
    const { deps, moveHead } = setup({ project }, store);
    const first = published(await publish(deps, IDENTITY, FIRST_COMMIT));
    store.put = () => Promise.reject(failure);
    moveHead(SECOND_COMMIT);

    await expect(publish(deps, IDENTITY, SECOND_COMMIT)).rejects.toBe(failure);

    expect(project).toHaveBeenCalledTimes(3);
    expect(project).toHaveBeenLastCalledWith(first.bundle, { folders: FIXTURE_FOLDERS });
    expect(store.published.get(REPOSITORY)?.version).toBe(1);
  });

  it("throws both failures when the registry cannot be projected back", async () => {
    const failure = new Error("The pointer write failed.");
    const undone = new Error("The registry refused the write.");
    const store = memoryVersionStore();
    let projections = 0;
    const project: NonNullable<PublishDeps["project"]> = async () => {
      projections += 1;
      if (projections === 3) throw undone;
    };
    const { deps, moveHead } = setup({ project }, store);
    published(await publish(deps, IDENTITY, FIRST_COMMIT));
    failNextSetPublished(store, failure);
    moveHead(SECOND_COMMIT);

    const error = await publish(deps, IDENTITY, SECOND_COMMIT).then(
      () => {
        throw new Error("expected the publish to fail");
      },
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([failure, undone]);
    expect((error as AggregateError).message).toBe(
      "Version 2 was not published, and MCP Studio's registry could not be put back on version 1. The next publish projects the registry again.",
    );
    expect(store.published.get(REPOSITORY)?.version).toBe(1);
  });

  it("projects back with the folders at the published version's commit", async () => {
    const failure = new Error("The pointer write failed.");
    const store = memoryVersionStore();
    const project = vi.fn<NonNullable<PublishDeps["project"]>>(async () => undefined);
    const tree = vi.fn<PublishDeps["tree"]>(async (_repository, commit) =>
      treeFromFiles(commit === SECOND_COMMIT ? repoWithZeta() : fixtureRepo()),
    );
    const { deps, moveHead } = setup({ project, tree }, store);
    const first = published(await publish(deps, IDENTITY, FIRST_COMMIT));
    failNextSetPublished(store, failure);
    moveHead(SECOND_COMMIT);

    await expect(publish(deps, IDENTITY, SECOND_COMMIT)).rejects.toBe(failure);

    expect(project.mock.calls.map(([, options]) => options)).toEqual([
      { folders: FIXTURE_FOLDERS },
      { folders: ["billing", "stripe", "zeta"] },
      { folders: FIXTURE_FOLDERS },
    ]);
    expect(project).toHaveBeenLastCalledWith(first.bundle, { folders: FIXTURE_FOLDERS });
    expect(tree).toHaveBeenLastCalledWith(REPOSITORY, FIRST_COMMIT);
  });

  it("throws both failures when the published version's tree cannot be read", async () => {
    const failure = new Error("The pointer write failed.");
    const unread = new Error("The host did not list the tree.");
    const store = memoryVersionStore();
    const project = vi.fn<NonNullable<PublishDeps["project"]>>(async () => undefined);
    let listings = 0;
    const tree: PublishDeps["tree"] = async () => {
      listings += 1;
      if (listings === 3) throw unread;
      return treeFromFiles(fixtureRepo());
    };
    const { deps, moveHead } = setup({ project, tree }, store);
    published(await publish(deps, IDENTITY, FIRST_COMMIT));
    failNextSetPublished(store, failure);
    moveHead(SECOND_COMMIT);

    const error = await publish(deps, IDENTITY, SECOND_COMMIT).then(
      () => {
        throw new Error("expected the publish to fail");
      },
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([failure, unread]);
    expect(project).toHaveBeenCalledTimes(2);
    expect(store.published.get(REPOSITORY)?.version).toBe(1);
  });

  it("has nothing to project back when the first version's pointer write fails", async () => {
    const failure = new Error("The pointer write failed.");
    const project = vi.fn<NonNullable<PublishDeps["project"]>>(async () => undefined);
    const { deps } = setup({ project }, failNextSetPublished(memoryVersionStore(), failure));

    await expect(publish(deps, IDENTITY, FIRST_COMMIT)).rejects.toBe(failure);

    expect(project).toHaveBeenCalledTimes(1);
  });

  it("projects nothing back when project() is not built", async () => {
    const failure = new Error("The pointer write failed.");
    const store = memoryVersionStore();
    const project = vi.fn<NonNullable<PublishDeps["project"]>>(async () => {
      throw new NotBuiltError("project");
    });
    const { deps, moveHead } = setup({ project }, store);
    published(await publish(deps, IDENTITY, FIRST_COMMIT));
    failNextSetPublished(store, failure);
    moveHead(SECOND_COMMIT);

    await expect(publish(deps, IDENTITY, SECOND_COMMIT)).rejects.toBe(failure);

    expect(project).toHaveBeenCalledTimes(2);
  });
});

// ── memoryVersionStore ───────────────────────────────────────────────────────

describe("memoryVersionStore", () => {
  async function firstBundle() {
    const { deps } = setup();
    return published(await publish(deps, IDENTITY, FIRST_COMMIT)).bundle;
  }

  it("starts with no published version and a highest version of 0", async () => {
    const store = memoryVersionStore();

    expect(await store.current(REPOSITORY)).toBeNull();
    expect(await store.highestVersion(REPOSITORY)).toBe(0);
  });

  it("counts a stored version that was never published", async () => {
    const store = memoryVersionStore();
    await store.put(await firstBundle());

    expect(await store.highestVersion(REPOSITORY)).toBe(1);
    expect(await store.current(REPOSITORY)).toBeNull();
  });

  it("refuses to store the same repository and version twice", async () => {
    const store = memoryVersionStore();
    const bundle = await firstBundle();
    await store.put(bundle);

    await expect(store.put(bundle)).rejects.toThrow(
      "github.com/a-intel/oxagen-core-platform already stored version 1.",
    );
    expect(store.versions.get(REPOSITORY)).toHaveLength(1);
  });

  it("stores the same version number for another repository", async () => {
    const store = memoryVersionStore();
    const bundle = await firstBundle();
    await store.put(bundle);
    await store.put({ ...bundle, repository: OTHER_REPOSITORY });

    expect(await store.highestVersion(REPOSITORY)).toBe(1);
    expect(await store.highestVersion(OTHER_REPOSITORY)).toBe(1);
  });

  it("returns null when the published pointer names a version it does not hold", async () => {
    const store = memoryVersionStore();
    await store.put(await firstBundle());
    await store.setPublished(REPOSITORY, { version: 3, commit: FIRST_COMMIT, ledger: null });

    expect(await store.current(REPOSITORY)).toBeNull();
  });

  it("runs one repository's work one call at a time", async () => {
    const store = memoryVersionStore();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = store.withLock(REPOSITORY, async () => {
      order.push("first starts");
      await gate;
      order.push("first ends");
      return 1;
    });
    const second = store.withLock(REPOSITORY, async () => {
      order.push("second starts");
      return 2;
    });
    release();

    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(["first starts", "first ends", "second starts"]);
  });

  it("runs the next call after one that rejects", async () => {
    const store = memoryVersionStore();
    const failure = new Error("The publish failed.");

    const first = store.withLock(REPOSITORY, async () => {
      throw failure;
    });
    const second = store.withLock(REPOSITORY, async () => "next");

    await expect(first).rejects.toBe(failure);
    expect(await second).toBe("next");
  });

  it("does not hold one repository's work behind another's", async () => {
    const store = memoryVersionStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const held = store.withLock(REPOSITORY, async () => {
      await gate;
      return "held";
    });

    expect(await store.withLock(OTHER_REPOSITORY, async () => "other")).toBe("other");
    release();
    expect(await held).toBe("held");
  });
});
