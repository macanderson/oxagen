// `record_working_copy` (MC spec §10.1): one row per machine and directory,
// written by `oxagen init` and `oxagen pull`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

import { workingCopyRecord } from "@oxagen/oxagen/contracts/repository.working_copy.record";
import {
  createWorkingCopyRecordHandler,
  toReport,
  upsertWorkingCopy,
  type WorkingCopyReport,
} from "./repository.working_copy.record";

const FIRST = new Date("2026-09-20T08:00:00.000Z");
const LAST = new Date("2026-09-24T17:00:00.000Z");

const INPUT = workingCopyRecord.input.parse({
  machineId: "0123456789abcdef",
  hostname: "mac-mini.local",
  directory: "/Users/ada/code/widgets",
  repository: "acme/widgets",
  branch: "feature/x",
  headCommit: "abc1234",
  oxagenPresent: true,
  symlinks: "linked",
  pulledCommit: "def5678",
  event: "pull",
  cliVersion: "1.4.0",
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("record_working_copy", () => {
  it("upserts the report under the caller's workspace and answers the row's id and instants", async () => {
    const upsert = vi.fn(async () => ({
      publicId: "wcp_0a1B",
      firstSeenAt: FIRST,
      lastSeenAt: LAST,
    }));
    const out = await createWorkingCopyRecordHandler({ upsert })(
      INPUT,
      makeCTX(),
    );
    expect(out).toEqual({
      workingCopyId: "wcp_0a1B",
      firstSeenAt: FIRST.toISOString(),
      lastSeenAt: LAST.toISOString(),
    });
    expect(workingCopyRecord.output.safeParse(out).success).toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      {
        machineId: "0123456789abcdef",
        hostname: "mac-mini.local",
        directory: "/Users/ada/code/widgets",
        repositoryFullName: "acme/widgets",
        branch: "feature/x",
        headCommit: "abc1234",
        oxagenPresent: true,
        symlinks: "linked",
        pulledCommit: "def5678",
        lastEvent: "pull",
        cliVersion: "1.4.0",
        reportedById: "u_1",
      },
    );
  });

  it("records no reporter for a call with no user, such as an API key", () => {
    expect(toReport(INPUT, null).reportedById).toBeNull();
  });

  it("refuses a machine id that is not a lowercase hex hash (negative)", () => {
    expect(
      workingCopyRecord.input.safeParse({ ...INPUT, machineId: "MY-SERIAL" })
        .success,
    ).toBe(false);
  });
});

describe("upsertWorkingCopy", () => {
  it("inserts on the unique key and, on conflict, updates every reported column and last_seen_at but not first_seen_at", async () => {
    const calls: {
      values?: Record<string, unknown>;
      conflict?: { target: unknown[]; set: Record<string, unknown> };
    } = {};
    const tx = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          calls.values = values;
          return {
            onConflictDoUpdate: (conflict: {
              target: unknown[];
              set: Record<string, unknown>;
            }) => {
              calls.conflict = conflict;
              return {
                returning: async () => [
                  { publicId: "wcp_1", firstSeenAt: FIRST, lastSeenAt: LAST },
                ],
              };
            },
          };
        },
      }),
    };
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    const report: WorkingCopyReport = toReport(INPUT, "u_1");
    await expect(
      upsertWorkingCopy({ orgId: "org_1", workspaceId: "ws_1" }, report),
    ).resolves.toEqual({
      publicId: "wcp_1",
      firstSeenAt: FIRST,
      lastSeenAt: LAST,
    });
    expect(calls.values).toMatchObject({
      ...report,
      orgId: "org_1",
      workspaceId: "ws_1",
    });
    expect(calls.conflict?.target).toHaveLength(4);
    const set = calls.conflict?.set ?? {};
    expect(Object.keys(set).sort()).toEqual(
      [
        "branch",
        "cliVersion",
        "headCommit",
        "hostname",
        "lastEvent",
        "lastSeenAt",
        "oxagenPresent",
        "pulledCommit",
        "reportedById",
        "repositoryFullName",
        "symlinks",
      ].sort(),
    );
    expect(set).not.toHaveProperty("firstSeenAt");
    expect(set).not.toHaveProperty("publicId");
    expect(set["reportedById"]).toBe("u_1");
  });
});
