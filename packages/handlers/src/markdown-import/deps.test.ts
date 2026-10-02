// deps.test.ts: the production deps over mocked stores and a mocked steering
// host, so the reads the import makes are pinned without a database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";

const db = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", () => ({
  schema: {
    organizations: { id: "organizations.id", slug: "organizations.slug" },
    workspaces: { id: "workspaces.id", orgId: "workspaces.org_id", slug: "workspaces.slug" },
  },
  withTenantDb: db.withTenantDb,
  // The org-wide seam is the same function as the tenant seam (ADR-086).
  withOrgDb: db.withTenantDb,
}));

const store = vi.hoisted(() => ({ listActiveRecords: vi.fn() }));
vi.mock("../context.steering.store", () => ({ postgresSteeringStore: store }));

const host = vi.hoisted(() => ({
  resolveRepository: vi.fn(),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  branchHead: vi.fn(),
}));
vi.mock("../tools.pr.open", () => ({ toolsSteeringHost: () => host }));

const opener = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./opener", () => ({ markdownImportPullRequestOpener: opener }));

const memoryStore = vi.hoisted(() => ({
  listWaiting: vi.fn(),
  listRejections: vi.fn(),
  insertMemoriesKeyed: vi.fn(),
}));
vi.mock("../memory/store", () => ({ postgresMemoryStore: memoryStore }));

// The model call has its own tests (split.test.ts). Mocking it here keeps the
// gateway and billing modules out of a suite whose database is a stub.
vi.mock("./split", () => ({ splitWithModel: vi.fn() }));

import { markdownImportDeps } from "./deps";
import { splitWithModel } from "./split";

const scope = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const repo = { fullName: "a-intel/steering", defaultBranch: "main", provider: "github" };

beforeEach(() => {
  for (const fn of [
    db.withTenantDb,
    store.listActiveRecords,
    host.resolveRepository,
    host.listFiles,
    host.readFile,
    host.branchHead,
    opener.open,
    memoryStore.listWaiting,
    memoryStore.listRejections,
    memoryStore.insertMemoriesKeyed,
  ]) {
    fn.mockReset();
  }
});

describe("markdownImportDeps", () => {
  it("reads the organization's and the workspace's slugs", async () => {
    db.withTenantDb.mockResolvedValue([{ organization: "a-intel", workspace: "core" }]);
    await expect(markdownImportDeps().names(scope)).resolves.toEqual({
      organization: "a-intel",
      workspace: "core",
    });
  });

  it("refuses a workspace that is not in the organization (negative)", async () => {
    db.withTenantDb.mockResolvedValue([]);
    const err = await markdownImportDeps()
      .names(scope)
      .catch((e: unknown) => e);
    expect(isHandlerError(err) && err.reason).toBe("workspace_not_found");
  });

  it("maps the registry's active records, and leaves out a record with no statement", async () => {
    store.listActiveRecords.mockResolvedValue([
      { slug: "a-intel.no-push", kind: "constraint", constraintEffect: "forbid", statement: "Never push to main.", path: "steering/a.md" },
      { slug: "a-intel.blank", kind: "fact", constraintEffect: null, statement: null, path: null },
      { slug: "a-intel.old", kind: null, constraintEffect: null, statement: "Old.", path: null },
    ]);
    await expect(markdownImportDeps().publishedRecords(scope)).resolves.toEqual([
      { lineage: "a-intel.no-push", kind: "constraint", effect: "forbid", statement: "Never push to main.", path: "steering/a.md" },
      { lineage: "a-intel.old", kind: "", effect: null, statement: "Old.", path: null },
    ]);
    expect(store.listActiveRecords).toHaveBeenCalledWith(scope);
  });

  it("reads every policy file on the production branch", async () => {
    host.resolveRepository.mockResolvedValue(repo);
    host.listFiles.mockResolvedValue([
      "policy/money.tests.jsonl",
      "policy/schema.cedarschema",
      "policy/money.cedar",
      "policy/deploys.cedar",
    ]);
    host.readFile.mockImplementation(async (_repo: unknown, path: string) =>
      path === "policy/deploys.cedar" ? null : `// ${path}`,
    );
    await expect(markdownImportDeps().publishedPolicies(scope)).resolves.toEqual([
      { path: "policy/money.cedar", text: "// policy/money.cedar" },
    ]);
    expect(host.listFiles).toHaveBeenCalledWith(repo, "main", "policy");
  });

  it("answers no policies for a workspace with no steering repo, and passes any other failure on", async () => {
    host.resolveRepository.mockRejectedValueOnce(
      new HandlerError({ code: "not_found", reason: "workspace_repository_missing", message: "none" }),
    );
    await expect(markdownImportDeps().publishedPolicies(scope)).resolves.toEqual([]);
    host.resolveRepository.mockRejectedValueOnce(new Error("host down"));
    await expect(markdownImportDeps().publishedPolicies(scope)).rejects.toThrow("host down");
  });

  it("reads whether a branch exists", async () => {
    host.resolveRepository.mockResolvedValue(repo);
    host.branchHead.mockResolvedValueOnce("abc").mockResolvedValueOnce(null);
    const deps = markdownImportDeps();
    await expect(deps.branchTaken(scope, "steering/import-2026-09-30")).resolves.toBe(true);
    await expect(deps.branchTaken(scope, "steering/import-2026-09-30-2")).resolves.toBe(false);
  });

  it("opens the PR through the Markdown import's opener, and splits with the model", async () => {
    opener.open.mockResolvedValue({ number: 1, url: "u", branch: "b", headSha: "h" });
    const deps = markdownImportDeps();
    const args = { branch: "b", title: "t", body: "x", commitMessage: "m", files: [] };
    await expect(deps.opener.open(scope, args)).resolves.toEqual({ number: 1, url: "u", branch: "b", headSha: "h" });
    expect(opener.open).toHaveBeenCalledWith(scope, args);
    expect(deps.split).toBe(splitWithModel);
    expect(deps.now()).toBeInstanceOf(Date);
  });

  it("reads the waiting memories' hashes and the rejected statements from the memory store", async () => {
    memoryStore.listWaiting.mockResolvedValue([
      { id: "uuid-1", publicId: "mem_01", statementHash: "hash-a", statement: "Use pnpm." },
    ]);
    memoryStore.listRejections.mockResolvedValue([
      { statementHash: "hash-b", rejectedAt: new Date("2026-09-01T00:00:00Z") },
    ]);
    await expect(markdownImportDeps().memories.held(scope)).resolves.toEqual({
      waiting: [{ publicId: "mem_01", statementHash: "hash-a" }],
      rejected: ["hash-b"],
    });
    expect(memoryStore.listWaiting).toHaveBeenCalledWith(scope);
    expect(memoryStore.listRejections).toHaveBeenCalledWith(scope);
  });

  it("stores the memories through the store's keyed insert", async () => {
    memoryStore.insertMemoriesKeyed.mockResolvedValue(["import:import:a.md#L1:hash"]);
    const drafts = [{ dedupeKey: "import:import:a.md#L1:hash" }] as never[];
    await expect(markdownImportDeps().memories.store(scope, drafts)).resolves.toEqual([
      "import:import:a.md#L1:hash",
    ]);
    expect(memoryStore.insertMemoriesKeyed).toHaveBeenCalledWith(scope, drafts);
  });
});
