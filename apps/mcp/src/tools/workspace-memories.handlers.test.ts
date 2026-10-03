// workspace-memories.handlers.test.ts: the MCP tools for workspace memories
// (memory-collection spec, lane MEM5, #4912): list_workspace_memories,
// get_workspace_memory, promote_memories, dismiss_memories,
// list_memory_pr_records, and drop_memory_record (#4518).
//
// The kernel `invoke` and the context seam `buildContext` are doubles. Each
// case checks that invoke received the contract name, the args, and
// { surface: "mcp" }, and that the output passed the contract's output schema
// on the way back.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import dismissMemories, { metadata as dismissMeta } from "./steering.memories.dismiss";
import getWorkspaceMemory, { metadata as getMeta } from "./steering.memories.get";
import listWorkspaceMemories, {
  metadata as listMeta,
  schema as listSchema,
} from "./steering.memories.list";
import promoteMemories, { metadata as promoteMeta } from "./steering.memories.promote";
import listMemoryPrRecords, {
  metadata as recordsMeta,
} from "./steering.memory_pr_records.list";
import dropMemoryRecord, {
  metadata as dropMeta,
} from "./steering.memory_pr_records.drop";

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

/** A Claude Code memory file's memory, as the list answers it. */
const MEMORY = {
  id: "mem_0a1b2c",
  label: "Use pnpm",
  summary: "The repo installs with pnpm.",
  statement: "Use pnpm, never npm, in this repository.",
  state: "waiting" as const,
  capture: "local_gateway" as const,
  harness: "claude-code" as const,
  agent: "agt.laptop",
  source: "claude-code:/home/dev/.claude/projects/-proj/memory/use-pnpm.md",
  repos: null,
  memory_type: "feedback",
  kind: "memory" as const,
  use_count: 3,
  use_signal: true,
  last_used_at: "2026-10-01T10:00:00.000Z",
  created_at: "2026-09-30T10:00:00.000Z",
  promoted_lineage: null,
  memory_pr: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

describe("the workspace memory tools carry their contract's name and hints", () => {
  it.each([
    [listMeta, "list_workspace_memories", true, false, true],
    [getMeta, "get_workspace_memory", true, false, true],
    [promoteMeta, "promote_memories", false, false, false],
    [dismissMeta, "dismiss_memories", false, false, true],
    [recordsMeta, "list_memory_pr_records", true, false, true],
    [dropMeta, "drop_memory_record", false, true, true],
  ])("%s", (meta, name, readOnly, destructive, idempotent) => {
    expect(meta.name).toBe(name);
    expect(meta.annotations?.readOnlyHint).toBe(readOnly);
    expect(meta.annotations?.destructiveHint).toBe(destructive);
    expect(meta.annotations?.idempotentHint).toBe(idempotent);
  });

  it("filters the list by state, harness, agent, repository, and type", () => {
    expect(Object.keys(listSchema)).toEqual([
      "states",
      "harness",
      "agent",
      "repository",
      "type",
      "limit",
      "offset",
    ]);
  });
});

describe("list_workspace_memories", () => {
  it("invokes with the contract name and forwards the groups", async () => {
    const output = {
      groups: [
        {
          memory: MEMORY,
          members: [MEMORY],
          use_count: 3,
          last_used_at: MEMORY.last_used_at,
        },
      ],
      total_groups: 1,
      total_memories: 1,
      truncated: false,
      waiting: 1,
    };
    mocks.invoke.mockResolvedValue(output);
    const args = {
      states: ["waiting" as const],
      harness: undefined,
      agent: undefined,
      repository: undefined,
      type: undefined,
      limit: 50,
      offset: 0,
    };
    await expect(
      listWorkspaceMemories(args),
    ).resolves.toHaveProperty("structuredContent", output);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_workspace_memories",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });

  it("refuses an output outside the contract", async () => {
    mocks.invoke.mockResolvedValue({ groups: [], total_groups: 0 });
    await expect(
      listWorkspaceMemories({
        states: ["waiting"],
        harness: undefined,
        agent: undefined,
        repository: undefined,
        type: undefined,
        limit: 50,
        offset: 0,
      }),
    ).rejects.toThrow();
  });
});

describe("get_workspace_memory", () => {
  it("invokes with the contract name and forwards the memory", async () => {
    const output = {
      memory: {
        ...MEMORY,
        run: null,
        evidence: [],
        applies_to: null,
        tools: null,
        retired_at: null,
        retired_reason: null,
      },
      uses: [
        {
          run: "tse_a1b2c3",
          signal: "read" as const,
          count: 2,
          used_at: "2026-10-01T10:00:00.000Z",
        },
      ],
      uses_total: 1,
      memory_pr: null,
    };
    mocks.invoke.mockResolvedValue(output);
    await expect(
      getWorkspaceMemory({ memory_id: "mem_0a1b2c" }),
    ).resolves.toHaveProperty("structuredContent", output);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_workspace_memory",
      { memory_id: "mem_0a1b2c" },
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

describe("promote_memories", () => {
  it("invokes with the contract name and forwards the memory PR", async () => {
    const output = {
      pull_request: {
        number: 7,
        url: "https://github.com/acme/steering/pull/7",
        branch: "memory/2026-10-01",
        opened: true,
      },
      records: [
        {
          path: "steering/memory/workspace/general/pnpm-never-npm-repository.md",
          lineage: "pnpm-never-npm-repository",
          kind: "memory" as const,
          force: "info" as const,
          effect: null,
          memory_ids: ["mem_0a1b2c"],
        },
      ],
      skipped: [],
    };
    mocks.invoke.mockResolvedValue(output);
    const args = { drafts: [{ memory_ids: ["mem_0a1b2c"] }], same_text: true };
    await expect(
      promoteMemories(args),
    ).resolves.toHaveProperty("structuredContent", output);
    expect(mocks.invoke).toHaveBeenCalledWith("promote_memories", args, fakeCtx, {
      surface: "mcp",
    });
  });
});

describe("dismiss_memories", () => {
  it("invokes with the contract name and forwards what changed", async () => {
    const output = {
      changed: ["mem_0a1b2c"],
      skipped: [{ memory_id: "mem_9z8y7x", state: null }],
      rejections: 1,
    };
    mocks.invoke.mockResolvedValue(output);
    const args = { memory_ids: ["mem_0a1b2c", "mem_9z8y7x"], restore: false };
    await expect(
      dismissMemories(args),
    ).resolves.toHaveProperty("structuredContent", output);
    expect(mocks.invoke).toHaveBeenCalledWith("dismiss_memories", args, fakeCtx, {
      surface: "mcp",
    });
  });
});

describe("list_memory_pr_records", () => {
  it("invokes with the contract name and forwards the records", async () => {
    const output = {
      pull_request: {
        id: "mpr_0a1b2c",
        number: 7,
        url: "https://github.com/acme/steering/pull/7",
        repository: "acme/steering",
        branch: "memory/2026-10-01",
        status: "open" as const,
        opened_at: "2026-10-01T10:00:00.000Z",
        settled_at: null,
      },
      branch_read: true,
      records: [
        {
          action: "propose" as const,
          path: "steering/memory/workspace/general/pnpm-never-npm-repository.md",
          lineage: "pnpm-never-npm-repository",
          kind: "memory" as const,
          title: "Use pnpm",
          summary: "Use pnpm, never npm, in this repository.",
          memories: [
            {
              id: "mem_0a1b2c",
              statement: MEMORY.statement,
              agent: "agt.laptop",
              run: null,
              evidence: [],
              state: "in_pr" as const,
            },
          ],
          dropped: null,
        },
      ],
    };
    mocks.invoke.mockResolvedValue(output);
    await expect(
      listMemoryPrRecords({ number: 7 }),
    ).resolves.toHaveProperty("structuredContent", output);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_memory_pr_records",
      { number: 7 },
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

describe("drop_memory_record", () => {
  it("invokes with the contract name and forwards the commit", async () => {
    const output = {
      pull_request: {
        number: 7,
        url: "https://github.com/acme/steering/pull/7",
        branch: "memory/2026-10-02",
      },
      path: "steering/memory/workspace/general/use-pnpm.md",
      lineage: "use-pnpm",
      commit_sha: "abc1234",
      already_dropped: false,
    };
    mocks.invoke.mockResolvedValueOnce(output);
    const args = { number: 7, path: "steering/memory/workspace/general/use-pnpm.md" };
    await expect(
      dropMemoryRecord(args),
    ).resolves.toHaveProperty("structuredContent", output);
    expect(mocks.invoke).toHaveBeenCalledWith("drop_memory_record", args, fakeCtx, {
      surface: "mcp",
    });
  });

  it("refuses an output outside the contract", async () => {
    mocks.invoke.mockResolvedValueOnce({ commit_sha: "abc1234" });
    await expect(
      dropMemoryRecord({ number: 7, path: "steering/memory/workspace/general/use-pnpm.md" }),
    ).rejects.toThrow();
  });
});
