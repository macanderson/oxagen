import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — factory must not reference variables declared after it.
vi.mock("../tenant", () => ({
  scopedSession: vi.fn().mockReturnValue({
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { scopedSession } from "../tenant";
import {
  projectSnapshotToGraph,
  removeCanonicalFiles,
  pruneLegacySourceDetail,
} from "./project-snapshot";

const mockScopedSession = vi.mocked(scopedSession);

const REPO = { providerRepoId: "123456", owner: "acme", name: "api" };
const SNAPSHOT = { commitSha: "abc1234def", treeSha: "tree9999" };
const SCOPES = [
  {
    scopeKey: "packages/billing",
    kind: "package",
    displayName: "@oxagen/billing",
    domainSlug: "billing",
    fileCount: 12,
  },
  {
    scopeKey: "packages/ui",
    kind: "package",
    displayName: "@oxagen/ui",
    fileCount: 40,
  },
];

describe("projectSnapshotToGraph", () => {
  let run: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    run = vi.fn().mockResolvedValue({ records: [] });
    close = vi.fn().mockResolvedValue(undefined);
    mockScopedSession.mockReturnValue({ run, close });
  });

  function firstCall() {
    return run.mock.calls[0] as [string, Record<string, unknown>];
  }
  function scopeCall() {
    return run.mock.calls.find(([cypher]) =>
      (cypher as string).includes("BINDS_SCOPE"),
    ) as [string, Record<string, unknown>] | undefined;
  }

  it("MERGEs the Repository on the immutable provider id (github:repo:{id})", async () => {
    await projectSnapshotToGraph({
      repository: REPO,
      snapshot: SNAPSHOT,
      scopes: SCOPES,
    });
    const [cypher, params] = firstCall();
    expect(cypher).toContain(
      "MERGE (repo:Repository {naturalKey: $repositoryKey, orgId: $orgId})",
    );
    expect(params.repositoryKey).toBe("github:repo:123456");
    expect(params.providerRepoId).toBe("123456");
    expect(params.owner).toBe("acme");
    expect(params.name).toBe("api");
  });

  it("MERGEs the RepositorySnapshot on commit SHA and links HAS_SNAPSHOT", async () => {
    await projectSnapshotToGraph({
      repository: REPO,
      snapshot: SNAPSHOT,
      scopes: SCOPES,
    });
    const [cypher, params] = firstCall();
    expect(cypher).toContain(
      "MERGE (snap:RepositorySnapshot {naturalKey: $snapshotKey, orgId: $orgId})",
    );
    expect(cypher).toContain("MERGE (repo)-[hs:HAS_SNAPSHOT]->(snap)");
    expect(params.snapshotKey).toBe("github:repo:123456:snapshot:abc1234def");
    expect(params.commitSha).toBe("abc1234def");
    expect(params.treeSha).toBe("tree9999");
  });

  it("anchors Repository + RepositorySnapshot as :GraphNode with is_system", async () => {
    await projectSnapshotToGraph({
      repository: REPO,
      snapshot: SNAPSHOT,
      scopes: SCOPES,
    });
    const [cypher] = firstCall();
    expect(cypher).toContain("repo:GraphNode");
    expect(cypher).toContain("snap:GraphNode");
    expect(cypher).toContain("repo.is_system      = true");
    expect(cypher).toContain("snap.is_system   = true");
  });

  it("does NOT write any symbol / chunk / embedding detail (four-store law)", async () => {
    await projectSnapshotToGraph({
      repository: REPO,
      snapshot: SNAPSHOT,
      scopes: SCOPES,
    });
    for (const [cypher] of run.mock.calls) {
      expect(cypher).not.toContain("SourceSymbol");
      expect(cypher).not.toContain("SourceChunk");
      expect(cypher).not.toMatch(/embedding/i);
      expect(cypher).not.toMatch(/\.content\b/);
    }
  });

  it("UNWINDs scopes into CodeScope nodes keyed github:{owner}/{repo}:scope:{scopeKey} with BINDS_SCOPE", async () => {
    await projectSnapshotToGraph({
      repository: REPO,
      snapshot: SNAPSHOT,
      scopes: SCOPES,
    });
    const call = scopeCall();
    expect(call).toBeDefined();
    const [cypher, params] = call!;
    expect(cypher).toContain("UNWIND $scopes AS scope");
    expect(cypher).toContain(
      "MERGE (cs:CodeScope {naturalKey: scope.naturalKey, orgId: $orgId})",
    );
    expect(cypher).toContain("MERGE (snap)-[bs:BINDS_SCOPE]->(cs)");
    const scopes = params.scopes as Array<Record<string, unknown>>;
    expect(scopes[0]).toMatchObject({
      naturalKey: "github:acme/api:scope:packages/billing",
      scopeKey: "packages/billing",
      kind: "package",
      displayName: "@oxagen/billing",
      domainSlug: "billing",
      fileCount: 12,
    });
  });

  it("defaults an absent domainSlug to null (no domains table at launch)", async () => {
    await projectSnapshotToGraph({
      repository: REPO,
      snapshot: SNAPSHOT,
      scopes: SCOPES,
    });
    const [, params] = scopeCall()!;
    const scopes = params.scopes as Array<Record<string, unknown>>;
    expect(scopes[1]!.domainSlug).toBeNull();
  });

  it("skips the scope UNWIND entirely when there are no scopes", async () => {
    await projectSnapshotToGraph({
      repository: REPO,
      snapshot: SNAPSHOT,
      scopes: [],
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(scopeCall()).toBeUndefined();
  });

  it("always closes the session", async () => {
    await projectSnapshotToGraph({
      repository: REPO,
      snapshot: SNAPSHOT,
      scopes: SCOPES,
    });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("removeCanonicalFiles", () => {
  let run: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    run = vi.fn().mockResolvedValue({ records: [] });
    close = vi.fn().mockResolvedValue(undefined);
    mockScopedSession.mockReturnValue({ run, close });
  });

  it("DETACH DELETEs SourceFile nodes by the canonical toNaturalKey identity", async () => {
    await removeCanonicalFiles({
      owner: "acme",
      repo: "api",
      paths: ["src/a.ts", "/src/b.ts"],
    });
    const [cypher, params] = run.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cypher).toContain("UNWIND $naturalKeys AS nk");
    expect(cypher).toContain(
      "MATCH (f:SourceFile {naturalKey: nk, orgId: $orgId})",
    );
    expect(cypher).toContain("DETACH DELETE f");
    // Leading slash on the second path is normalised by toNaturalKey.
    expect(params.naturalKeys).toEqual([
      "github:acme/api:src/a.ts",
      "github:acme/api:src/b.ts",
    ]);
  });

  it("no-ops (no session, no query) when paths is empty", async () => {
    await removeCanonicalFiles({ owner: "acme", repo: "api", paths: [] });
    expect(mockScopedSession).not.toHaveBeenCalled();
  });

  it("always closes the session", async () => {
    await removeCanonicalFiles({
      owner: "acme",
      repo: "api",
      paths: ["src/a.ts"],
    });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("pruneLegacySourceDetail", () => {
  let run: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    run = vi.fn().mockResolvedValue({ records: [] });
    close = vi.fn().mockResolvedValue(undefined);
    mockScopedSession.mockReturnValue({ run, close });
  });

  it("DETACH DELETEs legacy SourceSymbol and SourceChunk nodes by the repo infix", async () => {
    await pruneLegacySourceDetail({ owner: "acme", repo: "api" });
    const symbolCall = run.mock.calls.find(([c]) =>
      (c as string).includes("SourceSymbol"),
    );
    const chunkCall = run.mock.calls.find(([c]) =>
      (c as string).includes("SourceChunk"),
    );
    expect(symbolCall).toBeDefined();
    expect(chunkCall).toBeDefined();
    expect(symbolCall![0] as string).toContain("DETACH DELETE s");
    expect(chunkCall![0] as string).toContain("DETACH DELETE c");
    expect((symbolCall![1] as Record<string, unknown>).repoInfix).toBe(
      ":acme/api:",
    );
  });

  it("deletes legacy connectionId-prefixed SourceFile but NEVER the canonical nodes", async () => {
    await pruneLegacySourceDetail({ owner: "acme", repo: "api" });
    const fileCall = run.mock.calls.find(
      ([c]) =>
        (c as string).includes(":SourceFile") &&
        (c as string).includes("DETACH DELETE f"),
    );
    expect(fileCall).toBeDefined();
    const [cypher, params] = fileCall as [string, Record<string, unknown>];
    // The NOT STARTS WITH canonicalPrefix clause is what protects the freshly
    // projected canonical nodes from this cleanup.
    expect(cypher).toContain("f.naturalKey CONTAINS $repoInfix");
    expect(cypher).toContain("NOT f.naturalKey STARTS WITH $canonicalPrefix");
    expect(params.repoInfix).toBe(":acme/api:");
    expect(params.canonicalPrefix).toBe("github:acme/api:");
  });

  it("always closes the session", async () => {
    await pruneLegacySourceDetail({ owner: "acme", repo: "api" });
    expect(close).toHaveBeenCalledOnce();
  });
});
