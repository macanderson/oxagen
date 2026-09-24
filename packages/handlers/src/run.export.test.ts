/**
 * export_run and summarize_run: the two queued writes over a recording. The
 * org is tier-free in every case, so every refusal comes from the handler
 * (ARCHITECTURE.md §3.2, INV-29).
 */
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { runExport } from "@oxagen/oxagen/contracts/run.export";
import { runSummarize } from "@oxagen/oxagen/contracts/run.summarize";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("./event-client", () => ({ eventClient: { send: vi.fn() } }));

import {
  createRunExportHandler,
  RUN_EXPORT_EVENT,
  type RunExportDeps,
} from "./run.export";
import {
  createRunSummarizeHandler,
  RUN_SUMMARIZE_EVENT,
  type RunSummarizeDeps,
} from "./run.summarize";
import {
  ctx,
  KEY_CREATOR,
  keyCtx,
  ledgerRun,
  memoryEvents,
  memoryStores,
  memoryTachoFrames,
  roleTx,
  seal,
  summary,
  tachoSession,
} from "./run.test-support";

const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const LIVE_ID = "tse_livelivelivelivelivel";
const DIGEST_ONLY_ID = "tse_digestdigestdigestdig";
const IDLE_ID = "tse_idleidleidleidleidlei";

function harness(role: string | null, keyCreator: string | null = KEY_CREATOR) {
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(roleTx(role, keyCreator))),
  );
  const stores = memoryStores(
    [
      ledgerRun({
        publicId: LEDGER_ID,
        runId: RUN_UUID,
        seal: seal(RUN_UUID, { completenessGaps: ["digest_only"] }),
      }),
    ],
    [
      tachoSession({ publicId: TACHO_ID, session: { replayGrade: "view" } }),
      tachoSession({
        publicId: LIVE_ID,
        session: { outcome: "running", sealedAt: null },
      }),
      tachoSession({
        publicId: DIGEST_ONLY_ID,
        session: { replayGrade: "inspect", completenessGaps: ["digest_only"] },
      }),
      tachoSession({
        publicId: IDLE_ID,
        session: {
          outcome: "unknown",
          sealSource: "idle_timeout",
          replayGrade: "inspect",
          completenessGaps: ["unobserved_tail"],
        },
      }),
    ],
  );
  const read = {
    queries: stores.queries,
    store: {
      getRunByPublicId: (id: string) =>
        Promise.resolve(id === LEDGER_ID ? summary() : null),
      readAttemptEventsSince: memoryEvents([]),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: memoryTachoFrames("none", []),
  };
  const insertExport = vi.fn<RunExportDeps["insertExport"]>(() =>
    Promise.resolve({
      id: "0192d4a8-7c1e-7a00-8000-00000000e0e0",
      publicId: "rexp_0123456789abcdefghjkmn",
    }),
  );
  const dispatchExport = vi.fn<RunExportDeps["dispatch"]>(() =>
    Promise.resolve(),
  );
  const dispatchSummary = vi.fn<RunSummarizeDeps["dispatch"]>(() =>
    Promise.resolve(),
  );
  return {
    exportRun: createRunExportHandler({
      ...read,
      insertExport,
      dispatch: dispatchExport,
    }),
    summarize: createRunSummarizeHandler({
      ...read,
      dispatch: dispatchSummary,
    }),
    insertExport,
    dispatchExport,
    dispatchSummary,
  };
}

const conflict = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "conflict" && e.reason === reason;
const forbidden = (e: unknown) => isHandlerError(e) && e.code === "forbidden";
const refused = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "forbidden" && e.reason === reason;

describe("export_run", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the job in the tenant and dispatches the build, for a sealed run from either store", async () => {
    const h = harness("Admin");
    const out = await h.exportRun({ runId: TACHO_ID }, ctx());
    expect(runExport.output.parse(out)).toEqual(out);
    expect(out).toEqual({
      exportId: "rexp_0123456789abcdefghjkmn",
      status: "queued",
    });
    expect(h.insertExport).toHaveBeenCalledWith({
      orgId: ctx().orgId,
      workspaceId: ctx().workspaceId,
      runPublicId: TACHO_ID,
      requestedByUserId: ctx().userId,
    });
    expect(h.dispatchExport).toHaveBeenCalledWith({
      name: RUN_EXPORT_EVENT,
      data: {
        exportId: "0192d4a8-7c1e-7a00-8000-00000000e0e0",
        exportPublicId: "rexp_0123456789abcdefghjkmn",
        orgId: ctx().orgId,
        workspaceId: ctx().workspaceId,
        runPublicId: TACHO_ID,
      },
    });
    await expect(
      h.exportRun({ runId: LEDGER_ID }, ctx()),
    ).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("refuses a Member, a Viewer and a user with no org role, before any write (negative)", async () => {
    for (const role of ["Member", "Viewer", null]) {
      const h = harness(role);
      await expect(h.exportRun({ runId: TACHO_ID }, ctx())).rejects.toSatisfy(
        forbidden,
      );
      expect(h.insertExport).not.toHaveBeenCalled();
      expect(h.dispatchExport).not.toHaveBeenCalled();
    }
  });

  describe("an API-key call acts as the key's creator", () => {
    it("queues the export for a creator who is an org Admin, recorded as the requester", async () => {
      const h = harness("Admin");
      await expect(
        h.exportRun({ runId: TACHO_ID }, keyCtx()),
      ).resolves.toMatchObject({ status: "queued" });
      expect(h.insertExport).toHaveBeenCalledWith(
        expect.objectContaining({ requestedByUserId: KEY_CREATOR }),
      );
    });

    it("refuses a key whose creator is an org Member (negative)", async () => {
      const h = harness("Member");
      await expect(
        h.exportRun({ runId: TACHO_ID }, keyCtx()),
      ).rejects.toSatisfy(refused("org_role_required"));
      expect(h.insertExport).not.toHaveBeenCalled();
    });

    it("refuses a key with no creator (negative)", async () => {
      const h = harness("Owner", null);
      await expect(
        h.exportRun({ runId: TACHO_ID }, keyCtx()),
      ).rejects.toSatisfy(refused("no_principal"));
      expect(h.insertExport).not.toHaveBeenCalled();
    });
  });

  it("refuses a live run: the attestation signs the seal (negative)", async () => {
    const h = harness("Owner");
    await expect(h.exportRun({ runId: LIVE_ID }, ctx())).rejects.toSatisfy(
      conflict("run_not_sealed"),
    );
    expect(h.insertExport).not.toHaveBeenCalled();
  });

  it("refuses a run Oxagen closed for silence: its next frame undoes the close (negative, #3980)", async () => {
    const h = harness("Owner");
    await expect(h.exportRun({ runId: IDLE_ID }, ctx())).rejects.toSatisfy(
      conflict("run_not_sealed"),
    );
    expect(h.insertExport).not.toHaveBeenCalled();
  });

  it("is not_found for a run outside the workspace (negative)", async () => {
    const h = harness("Owner");
    await expect(h.exportRun({ runId: "tse_nope" }, ctx())).rejects.toSatisfy(
      (e) => isHandlerError(e) && e.code === "not_found",
    );
  });
});

describe("summarize_run", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queues the summary job for a sealed run whose bodies were kept", async () => {
    const h = harness("Member");
    const out = await h.summarize({ runId: TACHO_ID }, ctx());
    expect(runSummarize.output.parse(out)).toEqual(out);
    expect(out).toEqual({ runId: TACHO_ID, status: "queued" });
    expect(h.dispatchSummary).toHaveBeenCalledWith({
      name: RUN_SUMMARIZE_EVENT,
      data: {
        orgId: ctx().orgId,
        workspaceId: ctx().workspaceId,
        runPublicId: TACHO_ID,
        requestedByUserId: ctx().userId,
      },
    });
  });

  it("never runs on a digest_only recording, wrapped or ledger (negative)", async () => {
    const h = harness("Owner");
    for (const runId of [DIGEST_ONLY_ID, LEDGER_ID]) {
      await expect(h.summarize({ runId }, ctx())).rejects.toSatisfy(
        conflict("digest_only"),
      );
    }
    expect(h.dispatchSummary).not.toHaveBeenCalled();
  });

  it("refuses a live run, a Viewer and a user with no org role (negative)", async () => {
    const live = harness("Owner");
    await expect(live.summarize({ runId: LIVE_ID }, ctx())).rejects.toSatisfy(
      conflict("run_not_sealed"),
    );
    for (const role of ["Viewer", null]) {
      const h = harness(role);
      await expect(h.summarize({ runId: TACHO_ID }, ctx())).rejects.toSatisfy(
        forbidden,
      );
      expect(h.dispatchSummary).not.toHaveBeenCalled();
    }
  });
});
