// drop_memory_record (#4518) over fakes: a memory PR with two proposed
// records and one archived one, and a steering host that records what it was
// asked. The role check is a spy, so each case shows the handler asked it
// before it read anything. The last case runs the curator's settlement over
// the dropped PR, which is where the rejection is recorded.
import type { CapabilityContext } from "@oxagen/oxagen";
import { steeringMemoryPrRecordDrop } from "@oxagen/oxagen/contracts/steering.memory_pr_records.drop";
import { describe, expect, it, vi } from "vitest";
import type { SteeringHost } from "./context.steering.github";
import { MemoryStore, REPO } from "./context.steering.test-support";
import { settleMemoryPr } from "./memory/settle";
import type { WorkspaceMemoryPr } from "./memory/workspace-store";
import { createSteeringMemoryPrRecordDropHandler } from "./steering.memory_pr_records.drop";

const ctx: CapabilityContext = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req",
  messageId: null,
  surface: "api",
};
const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

const USE_PNPM = "steering/memory/workspace/general/use-pnpm.md";
const PIN = "steering/memory/workspace/general/pin-toolchain.md";
const OLD = "steering/memory/workspace/general/old-proxy.md";

const PR: WorkspaceMemoryPr = {
  id: "00000000-0000-4000-9000-0000000000bb",
  publicId: "mpr_8",
  provider: REPO.provider,
  repository: REPO.fullName,
  branch: "memory/2026-10-01",
  number: 8,
  url: "https://github.com/a-intel/platform/pull/8",
  status: "open",
  records: [
    {
      action: "propose",
      lineage: "use-pnpm",
      path: USE_PNPM,
      kind: "memory",
      memoryIds: ["00000000-0000-4000-8000-0000000000a1"],
      statementHashes: ["hash-use-pnpm"],
    },
    {
      action: "propose",
      lineage: "pin-toolchain",
      path: PIN,
      kind: "memory",
      memoryIds: ["00000000-0000-4000-8000-0000000000a2"],
      statementHashes: ["hash-pin"],
    },
    {
      action: "retire",
      lineage: "old-proxy",
      path: OLD,
      kind: "memory",
      memoryIds: [],
      statementHashes: [],
    },
  ],
  openedAt: new Date("2026-10-01T09:00:00.000Z"),
  settledAt: null,
};

function host(over: Partial<SteeringHost> = {}): SteeringHost {
  return {
    resolveRepository: vi.fn(async () => REPO),
    getPullRequest: vi.fn(async () => ({
      baseRef: "main",
      headSha: "head9",
      open: true,
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
    })),
    branchHead: vi.fn(async () => "head9"),
    listFiles: vi.fn(async () => [USE_PNPM, PIN]),
    lastCommitForPath: vi.fn(async () => ({ sha: "drop1" })),
    commitFiles: vi.fn(async () => ({ sha: "dropped9" })),
    ...over,
  } as unknown as SteeringHost;
}

function deps(target: WorkspaceMemoryPr | null, steering: SteeringHost = host()) {
  const store = new MemoryStore();
  return {
    workspace: { findMemoryPr: vi.fn(async () => target) },
    host: vi.fn(async () => steering),
    proposals: vi.fn(async () => store),
    author: vi.fn(async () => ({ userId: "user_1", source: "user:user_1" })),
    assertRole: vi.fn(async () => undefined),
    store,
  };
}

const input = (path: string, number = 8) =>
  steeringMemoryPrRecordDrop.input.parse({ number, path });

describe("drop_memory_record", () => {
  it("commits the delete of one record on the memory PR's branch, at the head it read", async () => {
    const steering = host();
    const d = deps(PR, steering);
    const out = await createSteeringMemoryPrRecordDropHandler(d)(input(PIN), ctx);

    expect(d.assertRole).toHaveBeenCalledWith(ctx);
    expect(d.workspace.findMemoryPr).toHaveBeenCalledWith(scope, { number: 8 });
    expect(steering.commitFiles).toHaveBeenCalledWith(REPO, {
      branch: "memory/2026-10-01",
      parent: "head9",
      message: "Drop pin-toolchain from memory PR #8",
      files: [{ path: PIN, content: null }],
    });
    expect(out).toEqual({
      pull_request: {
        number: 8,
        url: "https://github.com/a-intel/platform/pull/8",
        branch: "memory/2026-10-01",
      },
      path: PIN,
      lineage: "pin-toolchain",
      commit_sha: "dropped9",
      already_dropped: false,
    });
    // The memory PR's proposal row names the commit the drop made, so the
    // merge lands that head (ADR-265).
    expect(d.store.proposals).toEqual([
      expect.objectContaining({
        kind: "memory_pr",
        lineageId: "memory/2026-10-01",
        prNumber: 8,
        headSha: "dropped9",
        status: "pr_open",
        createdById: "user_1",
      }),
    ]);
  });

  it("moves an existing memory PR row to the drop's commit", async () => {
    const d = deps(PR);
    await d.store.insertProposal({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      lineageId: "memory/2026-10-01",
      kind: "memory_pr",
      force: "info",
      constraintEffect: null,
      sharingScope: "workspace",
      statement: "Memory PR 2026-10-01",
      rationale: "The curator opened it.",
      source: "memory-curator",
      supportRuns: [],
      supportAgents: [],
      supportingRecordIds: [],
      evidenceLinks: [],
      createdById: null,
      status: "pr_open",
      provider: REPO.provider,
      repository: REPO.fullName,
      baseRef: "main",
      branch: "memory/2026-10-01",
      path: "steering/memory/workspace/general",
      prNumber: 8,
      prUrl: PR.url,
      headSha: "head9",
      checks: [],
    });
    await createSteeringMemoryPrRecordDropHandler(d)(input(PIN), ctx);
    expect(d.store.proposals).toHaveLength(1);
    expect(d.store.proposals[0]).toMatchObject({
      headSha: "dropped9",
      source: "memory-curator",
    });
  });

  it("answers the commit that removed a record the branch no longer holds, and commits nothing", async () => {
    const steering = host({ listFiles: vi.fn(async () => [USE_PNPM]) });
    const out = await createSteeringMemoryPrRecordDropHandler(deps(PR, steering))(
      input(PIN),
      ctx,
    );
    expect(steering.lastCommitForPath).toHaveBeenCalledWith(
      REPO,
      PIN,
      "memory/2026-10-01",
    );
    expect(steering.commitFiles).not.toHaveBeenCalled();
    expect(out).toMatchObject({ commit_sha: "drop1", already_dropped: true });
  });

  it("refuses a number that names no memory PR, before reading the host (negative)", async () => {
    const d = deps(null);
    await expect(
      createSteeringMemoryPrRecordDropHandler(d)(input(PIN, 99), ctx),
    ).rejects.toMatchObject({ code: "not_found", reason: "memory_pr_not_found" });
    expect(d.host).not.toHaveBeenCalled();
  });

  it("refuses a memory PR the curator settled, before reading the host (negative)", async () => {
    for (const status of ["merged", "closed"] as const) {
      const d = deps({ ...PR, status, settledAt: new Date("2026-10-01T12:00:00.000Z") });
      await expect(
        createSteeringMemoryPrRecordDropHandler(d)(input(PIN), ctx),
      ).rejects.toMatchObject({ code: "conflict", reason: "memory_pr_settled" });
      expect(d.host).not.toHaveBeenCalled();
    }
  });

  it("refuses a memory PR the host merged or closed before the curator settled it (negative)", async () => {
    for (const merged of [true, false]) {
      const steering = host({
        getPullRequest: vi.fn(async () => ({
          baseRef: "main",
          headSha: "head9",
          open: false,
          merged,
          mergeCommitSha: merged ? "merge9" : null,
          mergedAt: merged ? new Date("2026-10-01T12:00:00.000Z") : null,
        })),
      });
      const err = createSteeringMemoryPrRecordDropHandler(deps(PR, steering))(
        input(PIN),
        ctx,
      );
      await expect(err).rejects.toMatchObject({
        code: "conflict",
        reason: "memory_pr_settled",
        message: expect.stringContaining(merged ? "merged on GitHub" : "closed on GitHub"),
      });
      expect(steering.commitFiles).not.toHaveBeenCalled();
    }
  });

  it("refuses a path the memory PR does not hold, and a record it archives (negative)", async () => {
    const steering = host();
    const handler = createSteeringMemoryPrRecordDropHandler(deps(PR, steering));
    await expect(
      handler(input("steering/rules/release-notes.md"), ctx),
    ).rejects.toMatchObject({ code: "not_found", reason: "record_not_in_pr" });
    await expect(handler(input(OLD), ctx)).rejects.toMatchObject({
      code: "conflict",
      reason: "record_not_proposed",
    });
    expect(steering.commitFiles).not.toHaveBeenCalled();
  });

  it("refuses a memory PR on a repository the workspace no longer uses (negative)", async () => {
    const steering = host();
    await expect(
      createSteeringMemoryPrRecordDropHandler(
        deps({ ...PR, repository: "a-intel/old-steering" }, steering),
      )(input(PIN), ctx),
    ).rejects.toMatchObject({ code: "conflict", reason: "memory_pr_elsewhere" });
    expect(steering.getPullRequest).not.toHaveBeenCalled();
  });

  it("refuses the last record the PR changes, since closing the PR rejects it (negative)", async () => {
    const only: WorkspaceMemoryPr = {
      ...PR,
      records: PR.records.filter((record) => record.action === "propose"),
    };
    const steering = host({ listFiles: vi.fn(async () => [PIN]) });
    await expect(
      createSteeringMemoryPrRecordDropHandler(deps(only, steering))(input(PIN), ctx),
    ).rejects.toMatchObject({ code: "conflict", reason: "last_record" });
    expect(steering.commitFiles).not.toHaveBeenCalled();
  });

  it("passes on the role check's refusal before reading anything (negative)", async () => {
    const d = deps(PR);
    d.assertRole.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { code: "forbidden" }),
    );
    await expect(
      createSteeringMemoryPrRecordDropHandler(d)(input(PIN), ctx),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(d.workspace.findMemoryPr).not.toHaveBeenCalled();
  });

  it("leaves the dropped record to the settlement, which rejects its statements when the PR merges", async () => {
    const steering = host();
    await createSteeringMemoryPrRecordDropHandler(deps(PR, steering))(
      input(PIN),
      ctx,
    );
    // The merge commit holds every file but the dropped one.
    const settled = settleMemoryPr(
      PR,
      { open: false, merged: true, mergedAt: new Date("2026-10-02T09:00:00.000Z") },
      new Set([USE_PNPM]),
      new Date("2026-10-02T09:00:01.000Z"),
    );
    expect(settled).toMatchObject({
      status: "merged",
      mergedLineages: ["use-pnpm"],
      rejectedHashes: ["hash-pin"],
      returnedMemoryIds: ["00000000-0000-4000-8000-0000000000a2"],
    });
  });
});
