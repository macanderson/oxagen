// `list_working_copies` (MC spec §10.1): the directories the CLI reported,
// most recently seen first, with the reporter's name.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

import { schema } from "@oxagen/database";
import { workingCopyList } from "@oxagen/oxagen/contracts/repository.working_copy.list";
import {
  createWorkingCopyListHandler,
  readWorkingCopies,
  type StoredWorkingCopy,
} from "./repository.working_copy.list";
import { makeCTX } from "./test-utils/fixtures";

const FIRST = new Date("2026-09-20T08:00:00.000Z");
const LAST = new Date("2026-09-24T17:00:00.000Z");

function stored(overrides: Partial<StoredWorkingCopy> = {}): StoredWorkingCopy {
  return {
    publicId: "wcp_0a1B",
    hostname: "mac-mini.local",
    directory: "/Users/ada/code/widgets",
    repositoryFullName: "acme/widgets",
    branch: "main",
    headCommit: "abc1234",
    oxagenPresent: true,
    symlinks: "linked",
    pulledCommit: "def5678",
    lastEvent: "pull",
    cliVersion: "1.4.0",
    reportedById: "3f1c6a6e-0000-4000-8000-000000000001",
    reporterName: "Ada Lovelace",
    firstSeenAt: FIRST,
    lastSeenAt: LAST,
    ...overrides,
  };
}

describe("list_working_copies", () => {
  it("answers each stored row in the contract's shape, in the order the read gave", async () => {
    const read = vi.fn(async () => [
      stored(),
      stored({
        publicId: "wcp_0c2D",
        directory: "/home/ada/scratch",
        repositoryFullName: null,
        branch: null,
        headCommit: null,
        oxagenPresent: false,
        symlinks: "none",
        pulledCommit: null,
        lastEvent: "init",
        cliVersion: null,
        reportedById: null,
        reporterName: null,
        lastSeenAt: FIRST,
      }),
    ]);
    const input = workingCopyList.input.parse({});
    const out = await createWorkingCopyListHandler({ read })(input, makeCTX());
    expect(read).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      100,
    );
    expect(out.workingCopies).toEqual([
      {
        id: "wcp_0a1B",
        hostname: "mac-mini.local",
        directory: "/Users/ada/code/widgets",
        repository: "acme/widgets",
        branch: "main",
        headCommit: "abc1234",
        oxagenPresent: true,
        symlinks: "linked",
        pulledCommit: "def5678",
        lastEvent: "pull",
        reportedBy: {
          userId: "3f1c6a6e-0000-4000-8000-000000000001",
          name: "Ada Lovelace",
        },
        cliVersion: "1.4.0",
        firstSeenAt: FIRST.toISOString(),
        lastSeenAt: LAST.toISOString(),
      },
      {
        id: "wcp_0c2D",
        hostname: "mac-mini.local",
        directory: "/home/ada/scratch",
        repository: null,
        branch: null,
        headCommit: null,
        oxagenPresent: false,
        symlinks: "none",
        pulledCommit: null,
        lastEvent: "init",
        reportedBy: null,
        cliVersion: null,
        firstSeenAt: FIRST.toISOString(),
        lastSeenAt: FIRST.toISOString(),
      },
    ]);
    expect(workingCopyList.output.safeParse(out).success).toBe(true);
  });

  it("keeps a reporter whose user row has no display name, with name null", async () => {
    const read = vi.fn(async () => [stored({ reporterName: null })]);
    const out = await createWorkingCopyListHandler({ read })(
      { limit: 5 },
      makeCTX(),
    );
    expect(read).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      5,
    );
    expect(out.workingCopies[0]?.reportedBy).toEqual({
      userId: "3f1c6a6e-0000-4000-8000-000000000001",
      name: null,
    });
  });

  it("refuses a limit past 200 (negative)", () => {
    expect(workingCopyList.input.safeParse({ limit: 201 }).success).toBe(false);
  });
});

describe("readWorkingCopies", () => {
  it("reads the workspace's rows joined to their reporter, newest first, at most limit", async () => {
    const seen: { joined?: unknown; limit?: number; ordered?: number } = {};
    const rows = [stored()];
    const chain = {
      from: () => chain,
      leftJoin: (table: unknown) => {
        seen.joined = table;
        return chain;
      },
      where: () => chain,
      orderBy: (...order: unknown[]) => {
        seen.ordered = order.length;
        return chain;
      },
      limit: async (n: number) => {
        seen.limit = n;
        return rows;
      },
    };
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ select: () => chain }),
    );
    await expect(
      readWorkingCopies({ orgId: "org_1", workspaceId: "ws_1" }, 25),
    ).resolves.toBe(rows);
    expect(seen.joined).toBe(schema.users);
    expect(seen.ordered).toBe(2);
    expect(seen.limit).toBe(25);
  });
});
