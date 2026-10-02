// instruction-files.handlers.test.ts: the MCP tools for the Repositories
// page's Instruction files section (#4518, ADR-253):
// list_code_repository_findings, promote_instruction_to_steering, and
// restore_managed_block.
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

import restoreManagedBlock, {
  metadata as restoreMeta,
  schema as restoreSchema,
} from "./context.pr.restore_managed_block";
import listCodeRepositoryFindings, {
  metadata as findingsMeta,
  schema as findingsSchema,
} from "./repository.findings.list";
import promoteInstruction, {
  metadata as promoteMeta,
  schema as promoteSchema,
} from "./repository.instruction.promote";

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

/** An AGENTS.md line that contradicts a steering record. */
const FINDING = {
  id: "crf_0a1b2c",
  path: "AGENTS.md",
  line: 12,
  statement: "Install packages with npm.",
  kind: "contradiction" as const,
  record: {
    lineage: "pnpm-never-npm",
    label: "Use pnpm",
    path: "steering/rules/pnpm-never-npm.md",
  },
  pull_request: {
    number: 42,
    url: "https://github.com/acme/platform/pull/42",
    state: "open" as const,
    head_sha: "abc1234",
  },
  file_url: "https://github.com/acme/platform/blob/abc1234/AGENTS.md#L12",
  checked_at: "2026-10-01T10:00:00.000Z",
  proposal: null,
};

const REPOSITORY = {
  repository_id: "rpb_0a",
  provider: "github" as const,
  full_name: "acme/platform",
  findings: [FINDING],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

describe("the instruction file tools carry their contract's name and hints", () => {
  it.each([
    [findingsMeta, "list_code_repository_findings", true, false, true],
    [promoteMeta, "promote_instruction_to_steering", false, false, false],
    [restoreMeta, "restore_managed_block", false, false, true],
  ])("%s", (meta, name, readOnly, destructive, idempotent) => {
    expect(meta.name).toBe(name);
    expect(meta.annotations?.readOnlyHint).toBe(readOnly);
    expect(meta.annotations?.destructiveHint).toBe(destructive);
    expect(meta.annotations?.idempotentHint).toBe(idempotent);
  });

  it("takes no arguments for the findings list", () => {
    expect(Object.keys(findingsSchema)).toEqual([]);
  });
});

describe("list_code_repository_findings", () => {
  it("invokes with the contract name and forwards the findings", async () => {
    const output = { repositories: [REPOSITORY] };
    mocks.invoke.mockResolvedValue(output);
    await expect(listCodeRepositoryFindings({})).resolves.toEqual(output);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_code_repository_findings",
      {},
      fakeCtx,
      { surface: "mcp" },
    );
  });

  it("refuses a finding kind outside the contract (negative)", async () => {
    mocks.invoke.mockResolvedValue({
      repositories: [{ ...REPOSITORY, findings: [{ ...FINDING, kind: "stale" }] }],
    });
    await expect(listCodeRepositoryFindings({})).rejects.toThrow();
  });
});

describe("promote_instruction_to_steering", () => {
  it("invokes with the contract name and forwards the proposal", async () => {
    const output = {
      proposal_id: "prp_0a1b2c",
      lineage: "pnpm-never-npm",
      status: "pr_open" as const,
      pull_request: {
        number: 9,
        url: "https://github.com/acme/steering/pull/9",
      },
    };
    mocks.invoke.mockResolvedValue(output);
    const args = { finding_id: "crf_0a1b2c" };
    await expect(promoteInstruction(args)).resolves.toEqual(output);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "promote_instruction_to_steering",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });

  it("refuses an id that is not a finding id (negative)", () => {
    expect(promoteSchema.finding_id.safeParse("mem_0a1b2c").success).toBe(false);
  });

  it("refuses an output with no proposal id (negative)", async () => {
    mocks.invoke.mockResolvedValue({
      lineage: "pnpm-never-npm",
      status: "pr_open",
      pull_request: null,
    });
    await expect(
      promoteInstruction({ finding_id: "crf_0a1b2c" }),
    ).rejects.toThrow();
  });
});

describe("restore_managed_block", () => {
  it("invokes with the contract name and forwards the commit", async () => {
    const output = {
      commit_sha: "def5678",
      status: "checks_running" as const,
    };
    mocks.invoke.mockResolvedValue(output);
    const args = { proposalId: "prp_0a1b2c", path: "AGENTS.md" as const };
    await expect(restoreManagedBlock(args)).resolves.toEqual(output);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "restore_managed_block",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });

  it("refuses a file that holds no managed block (negative)", () => {
    expect(restoreSchema.path.safeParse("NOTES.md").success).toBe(false);
  });

  it("refuses an id that is not a proposal id (negative)", () => {
    expect(restoreSchema.proposalId.safeParse("mpr_0a1b2c").success).toBe(false);
  });
});
