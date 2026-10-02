// list_code_repository_findings (S7, #4518; ADR-263): the stored statements,
// compared with today's records on every read. The store is in memory with
// the workspace's linked repositories, and the records are the steering repo
// fixture's.
import { HandlerError } from "@oxagen/oxagen";
import { codeRepositoryFindingsList } from "@oxagen/oxagen/contracts/repository.findings.list";
import { describe, expect, it, vi } from "vitest";
import { ctx, SCOPE } from "../context.steering.test-support";
import type { PublishedStatement } from "./findings";
import { createListCodeRepositoryFindingsHandler } from "./findings.list";
import type { StoredFinding } from "./store";
import { memoryFindingStore } from "./store.test-support";

const RECORDS: PublishedStatement[] = [
  {
    lineage: "a-intel.platform.no-push-to-main",
    label: "Never push to main",
    kind: "constraint",
    effect: "forbid",
    statement:
      "Do not push to `main` or force-push any shared branch. Open a pull request\nfrom a branch named for the work.",
    path: "steering/platform/a-intel.platform.no-push-to-main.md",
  },
  {
    lineage: "a-intel.platform.tenant-queries",
    label: "Scope every tenant query",
    kind: "code-rule",
    effect: null,
    statement: "Run every tenant query inside withTenantDb so row level security applies to it.",
    path: "steering/platform/a-intel.platform.tenant-queries.md",
  },
];

const CONTRADICTION = "Always push to `main` or force-push any shared branch.";
const REPEAT = "Run every tenant query inside withTenantDb so row level security applies to it.";
const HEAD = "9b1f6c0d2e3a4b5c6d7e8f90a1b2c3d4e5f60718";

function row(
  over: Pick<StoredFinding, "publicId" | "statement" | "line"> & Partial<StoredFinding>,
) {
  return {
    orgId: SCOPE.orgId,
    workspaceId: SCOPE.workspaceId,
    provider: "github" as const,
    providerRepositoryId: "771020341",
    repository: "a-intel/platform",
    pullRequestNumber: 318,
    pullRequestUrl: "https://github.com/a-intel/platform/pull/318",
    pullRequestState: "open" as const,
    headSha: HEAD,
    path: "AGENTS.md",
    proposalPublicId: null,
    checkedAt: new Date("2026-10-02T14:12:10.000Z"),
    ...over,
  };
}

function setup(records: PublishedStatement[] = RECORDS) {
  const store = memoryFindingStore([
    row({ publicId: "crf_contra", statement: CONTRADICTION, line: 3 }),
    row({ publicId: "crf_repeat", statement: REPEAT, line: 4, path: "CLAUDE.md" }),
    row({ publicId: "crf_nothing", statement: "The staging database resets every Sunday night.", line: 5 }),
    row({
      publicId: "crf_unlinked",
      statement: CONTRADICTION,
      line: 1,
      providerRepositoryId: "999",
      repository: "a-intel/old",
    }),
  ]);
  store.links.set("github:771020341", "rpb_link01");
  const publishedRecords = vi.fn(async () => records);
  const assertRole = vi.fn(async () => undefined);
  const handler = createListCodeRepositoryFindingsHandler({ store, publishedRecords, assertRole });
  return { store, publishedRecords, assertRole, handler };
}

describe("list_code_repository_findings", () => {
  it("lists each linked repository's statements that repeat or contradict a record today", async () => {
    const { handler, assertRole } = setup();
    const out = await handler({}, ctx());
    expect(codeRepositoryFindingsList.output.safeParse(out).success).toBe(true);
    expect(assertRole).toHaveBeenCalledTimes(1);
    expect(out.repositories).toHaveLength(1);
    const [repository] = out.repositories;
    expect(repository).toMatchObject({
      repository_id: "rpb_link01",
      provider: "github",
      full_name: "a-intel/platform",
    });
    expect(repository?.findings).toEqual([
      {
        id: "crf_contra",
        path: "AGENTS.md",
        line: 3,
        statement: CONTRADICTION,
        kind: "contradiction",
        record: {
          lineage: "a-intel.platform.no-push-to-main",
          label: "Never push to main",
          path: "steering/platform/a-intel.platform.no-push-to-main.md",
        },
        pull_request: {
          number: 318,
          url: "https://github.com/a-intel/platform/pull/318",
          state: "open",
          head_sha: HEAD,
        },
        file_url: `https://github.com/a-intel/platform/blob/${HEAD}/AGENTS.md#L3`,
        checked_at: "2026-10-02T14:12:10.000Z",
        proposal: null,
      },
      expect.objectContaining({
        id: "crf_repeat",
        path: "CLAUDE.md",
        kind: "repeat",
        record: expect.objectContaining({ lineage: "a-intel.platform.tenant-queries" }),
      }),
    ]);
  });

  it("drops a statement whose record was retired since the check ran", async () => {
    const { handler } = setup([RECORDS[1] as PublishedStatement]);
    const out = await handler({}, ctx());
    expect(out.repositories[0]?.findings.map((f) => f.id)).toEqual(["crf_repeat"]);
  });

  it("shows the proposal a promote opened, with its status", async () => {
    const { handler, store } = setup();
    await store.setProposal(SCOPE, "crf_contra", "prp_open1");
    store.proposals.set("prp_open1", "checks_running");
    const out = await handler({}, ctx());
    expect(out.repositories[0]?.findings[0]?.proposal).toEqual({
      id: "prp_open1",
      status: "checks_running",
    });
  });

  it("reads no records when no finding is stored (negative)", async () => {
    const { handler, store, publishedRecords } = setup();
    store.rows = [];
    await expect(handler({}, ctx())).resolves.toEqual({ repositories: [] });
    expect(publishedRecords).not.toHaveBeenCalled();
  });

  it("reads nothing for a caller the role check refuses (negative)", async () => {
    const { handler, assertRole, publishedRecords } = setup();
    assertRole.mockRejectedValueOnce(
      new HandlerError({ code: "forbidden", reason: "role_not_held" }),
    );
    await expect(handler({}, ctx())).rejects.toMatchObject({ reason: "role_not_held" });
    expect(publishedRecords).not.toHaveBeenCalled();
  });
});
