// The five workspace memory handlers over fakes (memory-collection spec,
// lane MEM5, #4912): list_workspace_memories, get_workspace_memory,
// promote_memories, dismiss_memories, and list_memory_pr_records.
//
// The role guard is a double, so each case asserts the handler asked it
// with its own contract before it read anything. The stores are fakes that
// record what they were asked. promote.test.ts covers the memory PR path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  promote: vi.fn(),
}));
vi.mock("./lib/capability-role-guard", () => ({ assertContractRole: mocks.role }));
vi.mock("./memory/promote", () => ({ promoteMemories: mocks.promote }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { steeringMemoriesDismiss } from "@oxagen/oxagen/contracts/steering.memories.dismiss";
import { steeringMemoriesGet } from "@oxagen/oxagen/contracts/steering.memories.get";
import {
  steeringMemoriesList,
  WORKSPACE_MEMORIES_GROUPED_MAX,
} from "@oxagen/oxagen/contracts/steering.memories.list";
import { steeringMemoriesPromote } from "@oxagen/oxagen/contracts/steering.memories.promote";
import { steeringMemoryPrRecordsList } from "@oxagen/oxagen/contracts/steering.memory_pr_records.list";
import type { SteeringHost } from "./context.steering.github";
import { REPO } from "./context.steering.test-support";
import { statementHash } from "./memory/statement";
import type { WorkspaceMemoryPr, WorkspaceMemoryRow } from "./memory/workspace-store";
import { createSteeringMemoriesDismissHandler } from "./steering.memories.dismiss";
import { createSteeringMemoriesGetHandler } from "./steering.memories.get";
import { createSteeringMemoriesListHandler } from "./steering.memories.list";
import { createSteeringMemoriesPromoteHandler } from "./steering.memories.promote";
import { createSteeringMemoryPrRecordsListHandler } from "./steering.memory_pr_records.list";

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

let n = 0;
function row(statement: string, over: Partial<WorkspaceMemoryRow> = {}): WorkspaceMemoryRow {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    publicId: `mem_${n}`,
    agentLineage: "agt.laptop",
    runPublicId: null,
    capture: "local_gateway",
    statement,
    statementHash: statementHash(statement),
    kind: "memory",
    repos: null,
    appliesTo: null,
    tools: null,
    evidence: [],
    source: `claude-code:/home/dev/.claude/projects/-p/memory/m${n}.md`,
    label: null,
    summary: null,
    memoryType: null,
    state: "waiting",
    useCount: 0,
    lastUsedAt: null,
    promotedLineage: null,
    retiredAt: null,
    retiredReason: null,
    createdAt: new Date("2026-09-30T10:00:00.000Z"),
    memoryPr: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role.mockResolvedValue("Owner");
});

describe("list_workspace_memories", () => {
  it("checks the role, reads the ranked memories with the filters, and groups them", async () => {
    const top = row("Use pnpm.", { useCount: 4 });
    const twin = row("use pnpm", { useCount: 1 });
    const other = row("Pin the toolchain.", { useCount: 2 });
    const deps = {
      listMemories: vi.fn(async () => ({ rows: [top, other, twin], total: 3 })),
      countWaiting: vi.fn(async () => 7),
    };
    const handler = createSteeringMemoriesListHandler(deps);
    const input = steeringMemoriesList.input.parse({
      harness: "claude-code",
      type: "feedback",
      limit: 1,
    });

    const out = await handler(input, ctx);

    expect(mocks.role).toHaveBeenCalledWith(steeringMemoriesList, ctx);
    expect(deps.listMemories).toHaveBeenCalledWith(
      scope,
      {
        states: ["waiting", "in_pr"],
        harness: "claude-code",
        agent: undefined,
        repository: undefined,
        type: "feedback",
      },
      WORKSPACE_MEMORIES_GROUPED_MAX,
    );
    expect(out.total_groups).toBe(2);
    expect(out.total_memories).toBe(3);
    expect(out.truncated).toBe(false);
    expect(out.waiting).toBe(7);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]?.members.map((m) => m.id)).toEqual([top.publicId, twin.publicId]);
    expect(out.groups[0]?.use_count).toBe(5);
    expect(steeringMemoriesList.output.safeParse(out).success).toBe(true);
  });

  it("says when more memories matched than the list groups", async () => {
    const handler = createSteeringMemoriesListHandler({
      listMemories: async () => ({ rows: [], total: WORKSPACE_MEMORIES_GROUPED_MAX + 1 }),
      countWaiting: async () => 0,
    });
    const out = await handler(steeringMemoriesList.input.parse({}), ctx);
    expect(out).toMatchObject({
      truncated: true,
      total_memories: WORKSPACE_MEMORIES_GROUPED_MAX,
    });
  });

  it("reads nothing when the role guard refuses", async () => {
    mocks.role.mockRejectedValue(new Error("forbidden"));
    const deps = { listMemories: vi.fn(), countWaiting: vi.fn() };
    await expect(
      createSteeringMemoriesListHandler(deps)(steeringMemoriesList.input.parse({}), ctx),
    ).rejects.toThrow("forbidden");
    expect(deps.listMemories).not.toHaveBeenCalled();
  });
});

describe("get_workspace_memory", () => {
  const pr: WorkspaceMemoryPr = {
    id: "00000000-0000-4000-9000-0000000000aa",
    publicId: "mpr_7",
    provider: "github",
    repository: "acme/steering",
    branch: "memory/2026-10-01",
    number: 7,
    url: "https://github.com/acme/steering/pull/7",
    status: "merged",
    records: [],
    openedAt: new Date("2026-10-01T09:00:00.000Z"),
    settledAt: new Date("2026-10-01T12:00:00.000Z"),
  };

  it("answers the memory with its uses and its memory PR", async () => {
    const memory = row("Use pnpm.", {
      state: "promoted",
      promotedLineage: "use-pnpm",
      useCount: 2,
      lastUsedAt: new Date("2026-10-01T11:00:00.000Z"),
      memoryPr: { id: pr.id, publicId: pr.publicId, number: 7, url: pr.url, status: "merged" },
    });
    const deps = {
      findMemories: vi.fn(async () => [memory]),
      listUses: vi.fn(async () => ({
        uses: [
          {
            runPublicId: "tse_a1b2c3",
            signal: "read" as const,
            count: 2,
            usedAt: new Date("2026-10-01T11:00:00.000Z"),
          },
        ],
        total: 1,
      })),
      findMemoryPr: vi.fn(async () => pr),
    };
    const out = await createSteeringMemoriesGetHandler(deps)(
      { memory_id: memory.publicId },
      ctx,
    );
    expect(mocks.role).toHaveBeenCalledWith(steeringMemoriesGet, ctx);
    expect(deps.listUses).toHaveBeenCalledWith(scope, memory.id, 100);
    expect(deps.findMemoryPr).toHaveBeenCalledWith(scope, { id: pr.id });
    expect(out.uses).toEqual([
      { run: "tse_a1b2c3", signal: "read", count: 2, used_at: "2026-10-01T11:00:00.000Z" },
    ]);
    expect(out.memory_pr).toEqual({
      id: "mpr_7",
      number: 7,
      url: pr.url,
      repository: "acme/steering",
      branch: "memory/2026-10-01",
      status: "merged",
      opened_at: "2026-10-01T09:00:00.000Z",
      settled_at: "2026-10-01T12:00:00.000Z",
    });
    expect(out.memory).toMatchObject({
      id: memory.publicId,
      state: "promoted",
      promoted_lineage: "use-pnpm",
      run: null,
      retired_at: null,
    });
    expect(steeringMemoriesGet.output.safeParse(out).success).toBe(true);
  });

  it("answers not_found for a memory the workspace does not hold", async () => {
    const deps = { findMemories: vi.fn(async () => []), listUses: vi.fn(), findMemoryPr: vi.fn() };
    await expect(
      createSteeringMemoriesGetHandler(deps)({ memory_id: "mem_other" }, ctx),
    ).rejects.toMatchObject({ code: "not_found", reason: "memory_not_found" });
    expect(deps.listUses).not.toHaveBeenCalled();
  });

  it("reads no memory PR for a memory none cited", async () => {
    const deps = {
      findMemories: vi.fn(async () => [row("Use pnpm.")]),
      listUses: vi.fn(async () => ({ uses: [], total: 0 })),
      findMemoryPr: vi.fn(),
    };
    const out = await createSteeringMemoriesGetHandler(deps)({ memory_id: "mem_1" }, ctx);
    expect(out.memory_pr).toBeNull();
    expect(deps.findMemoryPr).not.toHaveBeenCalled();
  });
});

describe("promote_memories", () => {
  it("checks the role, hands the drafts to the memory PR path, and answers in the contract's words", async () => {
    mocks.promote.mockResolvedValue({
      pullRequest: { number: 7, url: "https://github.com/acme/steering/pull/7", branch: "memory/2026-10-01", opened: true },
      records: [
        {
          path: "steering/memory/workspace/general/use-pnpm.md",
          lineage: "use-pnpm",
          kind: "memory",
          force: "info",
          effect: null,
          memoryIds: ["mem_1"],
        },
      ],
      skipped: [{ memoryId: "mem_2", reason: "not_waiting" }],
    });
    const promoteDeps = { host: {}, store: {}, workspace: {}, now: () => new Date() };
    const deps = vi.fn(async () => promoteDeps as never);
    const input = steeringMemoriesPromote.input.parse({
      drafts: [{ memory_ids: ["mem_1", "mem_2"] }],
      same_text: false,
    });

    const out = await createSteeringMemoriesPromoteHandler(deps)(input, ctx);

    expect(mocks.role).toHaveBeenCalledWith(steeringMemoriesPromote, ctx);
    expect(mocks.promote).toHaveBeenCalledWith(promoteDeps, scope, {
      drafts: input.drafts,
      sameText: false,
    });
    expect(out).toEqual({
      pull_request: { number: 7, url: "https://github.com/acme/steering/pull/7", branch: "memory/2026-10-01", opened: true },
      records: [
        {
          path: "steering/memory/workspace/general/use-pnpm.md",
          lineage: "use-pnpm",
          kind: "memory",
          force: "info",
          effect: null,
          memory_ids: ["mem_1"],
        },
      ],
      skipped: [{ memory_id: "mem_2", reason: "not_waiting" }],
    });
    expect(steeringMemoriesPromote.output.safeParse(out).success).toBe(true);
  });

  it("builds no deps and writes nothing when the role guard refuses", async () => {
    mocks.role.mockRejectedValue(new Error("forbidden"));
    const deps = vi.fn();
    await expect(
      createSteeringMemoriesPromoteHandler(deps)(
        steeringMemoriesPromote.input.parse({ drafts: [{ memory_ids: ["mem_1"] }] }),
        ctx,
      ),
    ).rejects.toThrow("forbidden");
    expect(deps).not.toHaveBeenCalled();
    expect(mocks.promote).not.toHaveBeenCalled();
  });
});

describe("dismiss_memories", () => {
  const AT = new Date("2026-10-01T12:00:00.000Z");
  const result = {
    changed: ["mem_1"],
    skipped: [{ publicId: "mem_2", state: "promoted" as const }],
    rejections: 1,
  };

  it("dismisses at the handler's clock", async () => {
    const deps = {
      dismissMemories: vi.fn(async () => result),
      restoreMemories: vi.fn(),
      now: () => AT,
    };
    const out = await createSteeringMemoriesDismissHandler(deps)(
      steeringMemoriesDismiss.input.parse({ memory_ids: ["mem_1", "mem_2"] }),
      ctx,
    );
    expect(mocks.role).toHaveBeenCalledWith(steeringMemoriesDismiss, ctx);
    expect(deps.dismissMemories).toHaveBeenCalledWith(scope, ["mem_1", "mem_2"], AT);
    expect(deps.restoreMemories).not.toHaveBeenCalled();
    expect(out).toEqual({
      changed: ["mem_1"],
      skipped: [{ memory_id: "mem_2", state: "promoted" }],
      rejections: 1,
    });
  });

  it("restores with restore: true", async () => {
    const deps = {
      dismissMemories: vi.fn(),
      restoreMemories: vi.fn(async () => ({ changed: [], skipped: [{ publicId: "mem_9", state: null }], rejections: 0 })),
    };
    const out = await createSteeringMemoriesDismissHandler(deps)(
      steeringMemoriesDismiss.input.parse({ memory_ids: ["mem_9"], restore: true }),
      ctx,
    );
    expect(deps.restoreMemories).toHaveBeenCalledWith(scope, ["mem_9"]);
    expect(deps.dismissMemories).not.toHaveBeenCalled();
    expect(out.skipped).toEqual([{ memory_id: "mem_9", state: null }]);
  });
});

describe("list_memory_pr_records", () => {
  const cited = row("Use pnpm, never npm.", { state: "in_pr", runPublicId: "tse_a1b2c3", evidence: ["frame:tse_a1b2c3/4"] });
  const pr: WorkspaceMemoryPr = {
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
        path: "steering/memory/workspace/general/use-pnpm.md",
        kind: "memory",
        memoryIds: [cited.id],
        statementHashes: [cited.statementHash],
      },
      {
        action: "propose",
        lineage: "pin-toolchain",
        path: "steering/memory/workspace/general/pin-toolchain.md",
        kind: "memory",
        memoryIds: ["00000000-0000-4000-8000-0000000fffff"],
        statementHashes: [],
      },
    ],
    openedAt: new Date("2026-10-01T09:00:00.000Z"),
    settledAt: null,
  };
  const RECORD = [
    "---",
    "schema: steering-record/v1",
    "lineage: use-pnpm",
    "label: Install with pnpm",
    "description: The repository installs with pnpm.",
    "kind: memory",
    "force: info",
    "scope: workspace",
    "status: active",
    "origin: inferred",
    "provenance:",
    "  source: run",
    "  uri: oxagen:run/tse_a1b2c3",
    "  memories:",
    "    - agent: agt.laptop",
    "      run: tse_a1b2c3",
    "      statement: Use pnpm, never npm.",
    "      evidence: []",
    "---",
    "",
    "Use pnpm, never npm.",
    "",
  ].join("\n");

  function host(over: Partial<SteeringHost> = {}): SteeringHost {
    return {
      resolveRepository: vi.fn(async () => REPO),
      branchHead: vi.fn(async () => "head9"),
      listFiles: vi.fn(async () => ["steering/memory/workspace/general/use-pnpm.md"]),
      readFile: vi.fn(async () => RECORD),
      lastCommitForPath: vi.fn(async () => ({ sha: "drop1" })),
      ...over,
    } as unknown as SteeringHost;
  }

  function depsWith(target: WorkspaceMemoryPr | null, steering: SteeringHost = host()) {
    return {
      workspace: {
        findMemoryPr: vi.fn(async () => target),
        memoriesByIds: vi.fn(async () => [cited]),
      },
      host: vi.fn(async () => steering),
    };
  }

  it("reads the open PR's branch for each record's label and the records dropped from it", async () => {
    const steering = host();
    const deps = depsWith(pr, steering);
    const out = await createSteeringMemoryPrRecordsListHandler(deps)({ number: 8 }, ctx);

    expect(mocks.role).toHaveBeenCalledWith(steeringMemoryPrRecordsList, ctx);
    expect(deps.workspace.findMemoryPr).toHaveBeenCalledWith(scope, { number: 8 });
    expect(steering.lastCommitForPath).toHaveBeenCalledWith(
      REPO,
      "steering/memory/workspace/general/pin-toolchain.md",
      "memory/2026-10-01",
    );
    expect(out.branch_read).toBe(true);
    expect(out.records).toEqual([
      {
        action: "propose",
        path: "steering/memory/workspace/general/use-pnpm.md",
        lineage: "use-pnpm",
        kind: "memory",
        title: "Install with pnpm",
        summary: "The repository installs with pnpm.",
        memories: [
          {
            id: cited.publicId,
            statement: "Use pnpm, never npm.",
            agent: "agt.laptop",
            run: "tse_a1b2c3",
            evidence: ["frame:tse_a1b2c3/4"],
            state: "in_pr",
          },
        ],
        dropped: null,
      },
      {
        action: "propose",
        path: "steering/memory/workspace/general/pin-toolchain.md",
        lineage: "pin-toolchain",
        kind: "memory",
        title: "pin-toolchain",
        summary: "pin-toolchain",
        memories: [],
        dropped: { commit_sha: "drop1" },
      },
    ]);
    expect(steeringMemoryPrRecordsList.output.safeParse(out).success).toBe(true);
  });

  it("answers from the memory PR row alone for a settled PR", async () => {
    const deps = depsWith({ ...pr, status: "merged", settledAt: new Date("2026-10-01T12:00:00.000Z") });
    const out = await createSteeringMemoryPrRecordsListHandler(deps)({ number: 8 }, ctx);
    expect(deps.host).not.toHaveBeenCalled();
    expect(out.branch_read).toBe(false);
    expect(out.pull_request.status).toBe("merged");
    expect(out.records[0]).toMatchObject({
      title: "Use pnpm, never npm",
      summary: "Use pnpm, never npm.",
      dropped: null,
    });
  });

  it("answers from the row when the host refuses the branch read", async () => {
    const deps = depsWith(
      pr,
      host({ listFiles: vi.fn(async () => Promise.reject(new Error("502"))) }),
    );
    const out = await createSteeringMemoryPrRecordsListHandler(deps)({ number: 8 }, ctx);
    expect(out.branch_read).toBe(false);
    expect(out.records.map((r) => r.dropped)).toEqual([null, null]);
  });

  it("does not read a branch on a repository the workspace no longer uses", async () => {
    const steering = host();
    const deps = depsWith({ ...pr, repository: "a-intel/old-steering" }, steering);
    const out = await createSteeringMemoryPrRecordsListHandler(deps)({ number: 8 }, ctx);
    expect(out.branch_read).toBe(false);
    expect(steering.listFiles).not.toHaveBeenCalled();
  });

  it("answers not_found for a number no memory PR of the workspace holds", async () => {
    await expect(
      createSteeringMemoryPrRecordsListHandler(depsWith(null))({ number: 99 }, ctx),
    ).rejects.toMatchObject({ code: "not_found", reason: "memory_pr_not_found" });
  });
});
