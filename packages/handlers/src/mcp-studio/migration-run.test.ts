// migration-run.test.ts: migrate_tools_to_steering's run against in-memory
// dependencies (ADR-245, #4948). The fake keeps the `tool_migration` record,
// the claim's hold, each PR's state on the host, and the folders on the
// default branch, so a test can call the run twice and see what the second
// call finds.
import type {
  MovableLegacyServer,
  OpenedSteeringPr,
} from "@oxagen/agent/runtime/steering-pr";
import { HandlerError } from "@oxagen/oxagen";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: logError, debug: vi.fn() },
}));

import {
  readToolMigrationRecord,
  runToolMigration,
  steeringRepoNotReady,
  TOOL_MIGRATION_LEASE_MS,
  TOOL_MIGRATION_SETTING,
  type MigrateCallArgs,
  type MigrateCallResult,
  type MigrationScope,
  type ToolMigrationDeps,
  type ToolMigrationRecord,
} from "./migration-run";

const SCOPE: MigrationScope = { orgId: "org_1", workspaceId: "ws_1" };
const ACTOR = { actorUserId: "usr_1" };
const NOW = new Date("2026-10-01T12:00:00.000Z");

const LINEAR: MovableLegacyServer = { id: "srv_linear", name: "Linear", steeringName: null };
const SENTRY: MovableLegacyServer = { id: "srv_sentry", name: "Sentry", steeringName: null };

function pr(number: number): OpenedSteeringPr {
  return {
    number,
    url: `https://github.com/acme/oxagen-support/pull/${number}`,
    branch: `tools/migrate-servers-20261001t120000z-${number}`,
  };
}

/** How the fake's migrate() behaves on its next call. */
type MigratePlan =
  | { open: OpenedSteeringPr[]; moved?: string[]; notMoved?: { name: string; reason: string }[] }
  | { open: OpenedSteeringPr[]; failAfter: Error };

class Fake implements ToolMigrationDeps {
  steeringRepo = true;
  movable: MovableLegacyServer[] = [LINEAR];
  record: ToolMigrationRecord | null = null;
  /** The record as each save and claim wrote it, in order. */
  writes: ToolMigrationRecord[] = [];
  prStates = new Map<number, { open: boolean; merged: boolean }>();
  folders: string[] = [];
  plan: MigratePlan = { open: [pr(12)], moved: ["srv_linear"] };
  migrateCalls: Omit<MigrateCallArgs, "onOpened">[] = [];
  claims: Date[] = [];
  saveFails = false;
  clock = NOW;

  now = () => this.clock;

  hasSteeringRepo = vi.fn(async () => this.steeringRepo);

  movableServers = vi.fn(async () => this.movable);

  readRecord = vi.fn(async () => (this.record ? structuredClone(this.record) : null));

  claim = vi.fn(async (_scope: MigrationScope, record: ToolMigrationRecord, staleBefore: Date) => {
    this.claims.push(staleBefore);
    const held =
      this.record?.status === "running" && new Date(this.record.updated_at) > staleBefore;
    if (held) return false;
    this.write(record);
    return true;
  });

  saveRecord = vi.fn(async (_scope: MigrationScope, record: ToolMigrationRecord) => {
    if (this.saveFails) throw new Error("connection reset");
    this.write(record);
  });

  pullRequestState = vi.fn(async (_scope: MigrationScope, number: number) => {
    const state = this.prStates.get(number);
    if (!state) throw new Error(`no PR #${number}`);
    return state;
  });

  serverFolders = vi.fn(async () => [...this.folders]);

  migrate = vi.fn(async (_scope: MigrationScope, args: MigrateCallArgs): Promise<MigrateCallResult> => {
    this.migrateCalls.push({
      existingFolders: [...args.existingFolders],
      actorUserId: args.actorUserId,
    });
    for (const opened of this.plan.open) {
      this.prStates.set(opened.number, { open: true, merged: false });
      await args.onOpened(opened);
    }
    if ("failAfter" in this.plan) throw this.plan.failAfter;
    return {
      opened: this.plan.open,
      movedServerIds: this.plan.moved ?? [],
      notMoved: this.plan.notMoved ?? [],
    };
  });

  private write(record: ToolMigrationRecord): void {
    this.record = structuredClone(record);
    this.writes.push(structuredClone(record));
  }
}

let fake: Fake;
beforeEach(() => {
  fake = new Fake();
  logError.mockReset();
});

const run = () => runToolMigration(SCOPE, ACTOR, fake);

const PR_12 = { number: 12, url: "https://github.com/acme/oxagen-support/pull/12" };

describe("the first run", () => {
  it("opens the migration PR and answers it as opened", async () => {
    fake.folders = ["github"];

    await expect(run()).resolves.toEqual({
      state: "opened",
      pullRequest: PR_12,
      pullRequests: [PR_12],
    });
    expect(fake.migrateCalls).toEqual([{ existingFolders: ["github"], actorUserId: "usr_1" }]);
    expect(fake.record).toEqual({
      status: "done",
      prs: [pr(12)],
      error: null,
      updated_at: NOW.toISOString(),
    });
  });

  it("claims the workspace before it opens anything, with a hold of ten minutes", async () => {
    await run();

    expect(fake.claims).toEqual([new Date(NOW.getTime() - TOOL_MIGRATION_LEASE_MS)]);
    expect(TOOL_MIGRATION_LEASE_MS).toBe(10 * 60 * 1000);
    expect(fake.writes[0]).toMatchObject({ status: "running", prs: [] });
    expect(fake.claim.mock.invocationCallOrder[0]).toBeLessThan(
      fake.migrate.mock.invocationCallOrder[0] as number,
    );
  });

  it("records each PR as it opens, before the next batch opens", async () => {
    fake.plan = { open: [pr(12), pr(13)], moved: ["srv_linear", "srv_sentry"] };
    fake.movable = [LINEAR, SENTRY];

    const result = await run();

    expect(result.state).toBe("opened");
    expect(result.pullRequests.map((p) => p.number)).toEqual([12, 13]);
    expect(fake.writes.map((w) => [w.status, w.prs.map((p) => p.number)])).toEqual([
      ["running", []],
      ["running", [12]],
      ["running", [12, 13]],
      ["done", [12, 13]],
    ]);
  });

  it("passes a service run's null actor through", async () => {
    await runToolMigration(SCOPE, { actorUserId: null }, fake);
    expect(fake.migrateCalls[0]?.actorUserId).toBeNull();
  });

  it("answers the opened PR when its record cannot be saved, and logs the PR", async () => {
    // The claim writes; every later save fails.
    fake.saveFails = true;

    await expect(run()).resolves.toEqual({
      state: "opened",
      pullRequest: PR_12,
      pullRequests: [PR_12],
    });
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ pr: 12, err: "connection reset" }),
      expect.stringContaining("not recorded"),
    );
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ prs: [12] }),
      expect.stringContaining("could not be recorded"),
    );
  });
});

describe("a retry while the PR is open", () => {
  it("answers the open PR and opens no second one", async () => {
    await run();
    fake.migrate.mockClear();
    fake.claim.mockClear();

    await expect(run()).resolves.toEqual({
      state: "already_open",
      pullRequest: PR_12,
      pullRequests: [PR_12],
    });
    expect(fake.pullRequestState).toHaveBeenCalledWith(SCOPE, 12);
    expect(fake.claim).not.toHaveBeenCalled();
    expect(fake.migrate).not.toHaveBeenCalled();
  });

  it("answers every batch still open, and skips one that merged", async () => {
    fake.record = {
      status: "done",
      prs: [pr(12), pr(13)],
      error: null,
      updated_at: NOW.toISOString(),
    };
    fake.prStates.set(12, { open: false, merged: true });
    fake.prStates.set(13, { open: true, merged: false });

    const result = await run();

    expect(result.state).toBe("already_open");
    expect(result.pullRequests.map((p) => p.number)).toEqual([13]);
    expect(fake.migrate).not.toHaveBeenCalled();
  });

  it("refuses while another run holds the workspace", async () => {
    fake.record = { status: "running", prs: [], error: null, updated_at: NOW.toISOString() };

    await expect(run()).rejects.toMatchObject({
      code: "conflict",
      reason: "tool_migration_running",
    });
    expect(fake.migrate).not.toHaveBeenCalled();
  });

  it("takes over a hold that went quiet for longer than the lease", async () => {
    fake.record = {
      status: "running",
      prs: [],
      error: null,
      updated_at: new Date(NOW.getTime() - TOOL_MIGRATION_LEASE_MS - 1).toISOString(),
    };

    await expect(run()).resolves.toMatchObject({ state: "opened" });
  });
});

describe("a migrated workspace", () => {
  it("answers already_migrated with the merged PR once the publish took the rows over", async () => {
    await run();
    // The PR merged, and the publish turned the row into a steering row.
    fake.prStates.set(12, { open: false, merged: true });
    fake.movable = [];
    fake.migrate.mockClear();
    fake.pullRequestState.mockClear();

    await expect(run()).resolves.toEqual({
      state: "already_migrated",
      pullRequest: PR_12,
      pullRequests: [PR_12],
    });
    expect(fake.migrate).not.toHaveBeenCalled();
    expect(fake.pullRequestState).not.toHaveBeenCalled();
  });

  it("answers already_migrated with no PR when the workspace never had a server to move", async () => {
    fake.movable = [];

    await expect(run()).resolves.toEqual({
      state: "already_migrated",
      pullRequest: null,
      pullRequests: [],
    });
    expect(fake.claim).not.toHaveBeenCalled();
    expect(fake.record).toBeNull();
  });

  it("answers the merged PR while its rows wait on the publish, and opens nothing", async () => {
    fake.record = { status: "done", prs: [pr(12)], error: null, updated_at: NOW.toISOString() };
    fake.prStates.set(12, { open: false, merged: true });
    fake.movable = [{ ...LINEAR, steeringName: "linear" }];
    fake.folders = ["linear"];
    fake.plan = { open: [] };

    await expect(run()).resolves.toEqual({
      state: "already_migrated",
      pullRequest: PR_12,
      pullRequests: [PR_12],
    });
    expect(fake.migrateCalls).toEqual([{ existingFolders: ["linear"], actorUserId: "usr_1" }]);
    expect(fake.record).toMatchObject({ status: "done", prs: [pr(12)] });
  });
});

describe("a PR that closed unmerged", () => {
  it("opens the migration again and records the new PR in place of the closed one", async () => {
    fake.record = { status: "done", prs: [pr(12)], error: null, updated_at: NOW.toISOString() };
    fake.prStates.set(12, { open: false, merged: false });
    fake.movable = [{ ...LINEAR, steeringName: "linear" }];
    fake.plan = { open: [pr(14)], moved: ["srv_linear"] };

    const result = await run();

    expect(result).toMatchObject({ state: "opened", pullRequest: { number: 14 } });
    expect(fake.record?.prs).toEqual([pr(14)]);
  });
});

describe("refusals", () => {
  it("refuses a workspace with no steering repo, naming the step that sets one up", async () => {
    fake.steeringRepo = false;

    const err = await run().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HandlerError);
    expect(err).toMatchObject({ code: "not_found", reason: "steering_repo_not_ready" });
    expect((err as Error).message).toContain("retry_steering_repo_provision");
    expect((err as Error).message).toContain("import_workspace_steering");
    expect((err as Error).message).toContain("migrate_tools_to_steering again");
    expect(fake.movableServers).not.toHaveBeenCalled();
    expect(fake.claim).not.toHaveBeenCalled();
    expect(fake.migrate).not.toHaveBeenCalled();
  });

  it("refuses a workspace with no steering repo even when it has no server to move", async () => {
    fake.steeringRepo = false;
    fake.movable = [];

    await expect(run()).rejects.toMatchObject({ reason: "steering_repo_not_ready" });
  });

  it("refuses when every server left cannot move, listing why, and records the failure", async () => {
    fake.movable = [LINEAR];
    fake.plan = {
      open: [],
      notMoved: [
        { name: "Linear", reason: "its URL has a query string." },
        { name: "Local files", reason: "it runs as a local process (stdio)." },
      ],
    };

    const err = await run().catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "conflict", reason: "servers_not_movable" });
    const message = (err as Error).message;
    expect(message).toContain("1 server cannot move");
    expect(message).toContain("Linear: its URL has a query string.");
    // A stdio server is not counted, so it does not block the workspace.
    expect(message).not.toContain("Local files");
    expect(fake.record).toMatchObject({
      status: "failed",
      error: { code: "servers_not_movable" },
    });
  });

  it("names a stuck server migrate() did not list with a general reason", async () => {
    fake.movable = [LINEAR, SENTRY];
    fake.plan = { open: [], notMoved: [{ name: "Linear", reason: "its auth strategy oauth has no server.toml form." }] };

    const err = await run().catch((e: unknown) => e);

    expect((err as Error).message).toContain("2 servers cannot move");
    expect((err as Error).message).toContain("Sentry: it cannot be written as a server folder.");
  });

  it("records a migration that failed after a batch opened, and the retry answers that batch", async () => {
    fake.movable = [LINEAR, SENTRY];
    fake.plan = { open: [pr(12)], failAfter: new Error("GitHub refused the second branch") };

    await expect(run()).rejects.toThrow("GitHub refused the second branch");
    expect(fake.record).toMatchObject({
      status: "failed",
      prs: [pr(12)],
      error: { code: "migration_failed", message: "GitHub refused the second branch" },
    });

    fake.migrate.mockClear();
    await expect(run()).resolves.toMatchObject({ state: "already_open", pullRequests: [PR_12] });
    expect(fake.migrate).not.toHaveBeenCalled();
  });

  it("turns migrate()'s missing-opener error into a conflict", async () => {
    const unavailable = Object.assign(new Error("No steering PR opener is registered."), {
      code: "steering_pr_unavailable",
    });
    fake.plan = { open: [], failAfter: unavailable };

    await expect(run()).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_pr_unavailable",
      message: "No steering PR opener is registered.",
    });
    expect(fake.record).toMatchObject({
      status: "failed",
      error: { code: "steering_pr_unavailable" },
    });
  });

  it("passes a HandlerError from migrate() through as it is", async () => {
    const refusal = new HandlerError({
      code: "conflict",
      reason: "tools_branch_exists",
      message: "tools/migrate-servers-1 already exists.",
    });
    fake.plan = { open: [], failAfter: refusal };

    await expect(run()).rejects.toBe(refusal);
    expect(fake.record?.error).toEqual({
      code: "tools_branch_exists",
      message: "tools/migrate-servers-1 already exists.",
    });
  });

  it("still throws migrate()'s error when the failure cannot be recorded", async () => {
    fake.plan = { open: [], failAfter: new Error("host down") };
    fake.saveFails = true;

    await expect(run()).rejects.toThrow("host down");
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ err: "connection reset" }),
      expect.stringContaining("could not be recorded"),
    );
  });
});

describe("steeringRepoNotReady", () => {
  it("is a not_found refusal", () => {
    expect(steeringRepoNotReady()).toMatchObject({
      code: "not_found",
      reason: "steering_repo_not_ready",
    });
  });
});

describe("readToolMigrationRecord", () => {
  const RECORD: ToolMigrationRecord = {
    status: "done",
    prs: [pr(12)],
    error: null,
    updated_at: NOW.toISOString(),
  };

  it("reads the record the settings hold", () => {
    expect(readToolMigrationRecord({ [TOOL_MIGRATION_SETTING]: RECORD, other: 1 })).toEqual(RECORD);
  });

  it("reads nothing from settings that hold no record", () => {
    expect(readToolMigrationRecord(null)).toBeNull();
    expect(readToolMigrationRecord("text")).toBeNull();
    expect(readToolMigrationRecord({})).toBeNull();
    expect(readToolMigrationRecord({ [TOOL_MIGRATION_SETTING]: "done" })).toBeNull();
    expect(readToolMigrationRecord({ [TOOL_MIGRATION_SETTING]: { status: "paused" } })).toBeNull();
  });

  it("drops a PR entry that does not parse, and fills a missing time and error", () => {
    expect(
      readToolMigrationRecord({
        [TOOL_MIGRATION_SETTING]: {
          status: "failed",
          prs: [pr(12), { number: 0, url: "x", branch: "y" }, { number: 3 }, "13"],
          error: { code: "migration_failed" },
        },
      }),
    ).toEqual({
      status: "failed",
      prs: [pr(12)],
      error: null,
      updated_at: new Date(0).toISOString(),
    });
  });

  it("keeps a recorded error", () => {
    const error = { code: "servers_not_movable", message: "No migration PR was opened." };
    expect(
      readToolMigrationRecord({ [TOOL_MIGRATION_SETTING]: { ...RECORD, status: "failed", error } }),
    ).toMatchObject({ status: "failed", error });
  });
});
