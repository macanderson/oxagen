/**
 * summarize_run. The org is tier-free in every case, so every refusal below
 * comes from the handler (ARCHITECTURE.md §3.2, INV-29). The model call is
 * the durable function's; here the handler queues it or refuses.
 */
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { runSummarize } from "@oxagen/oxagen/contracts/run.summarize";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import {
  createRunSummarizeHandler,
  RUN_SUMMARIZE_EVENT,
  type RunSummarizeDeps,
} from "./run.summarize";
import {
  ctx,
  ledgerRun,
  memoryEvents,
  memoryStores,
  memoryTachoFrames,
  roleTx,
  SCOPE,
  seal,
  summary,
  tachoSession,
} from "./run.test-support";

const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";

function harness(over: {
  role?: string | null;
  ledger?: Parameters<typeof ledgerRun>[0];
  session?: NonNullable<Parameters<typeof tachoSession>[0]["session"]>;
}) {
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(roleTx(over.role === undefined ? "Member" : over.role))),
  );
  const stores = memoryStores(
    [
      ledgerRun({
        publicId: LEDGER_ID,
        runId: RUN_UUID,
        seal: seal(RUN_UUID),
        ...over.ledger,
      }),
    ],
    [tachoSession({ publicId: TACHO_ID, session: over.session })],
  );
  const dispatch = vi.fn(() => Promise.resolve());
  const deps: RunSummarizeDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: (id) =>
        Promise.resolve(id === LEDGER_ID ? summary() : null),
      readAttemptEventsSince: memoryEvents([]),
    },
    readRunCosts: stores.readRunCosts,
    tachoFrames: memoryTachoFrames("none", []),
    dispatch,
  };
  return { summarize: createRunSummarizeHandler(deps), dispatch };
}

const conflict = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "conflict" && e.reason === reason;

describe("summarize_run", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queues the job for a sealed ledger run with the caller's scope and identity", async () => {
    const { summarize, dispatch } = harness({});
    const out = await summarize({ runId: LEDGER_ID }, ctx());
    expect(runSummarize.output.parse(out)).toEqual(out);
    expect(out).toEqual({ runId: LEDGER_ID, status: "queued" });
    expect(dispatch).toHaveBeenCalledWith({
      name: RUN_SUMMARIZE_EVENT,
      data: {
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        runPublicId: LEDGER_ID,
        requestedByUserId: ctx().userId,
      },
    });
  });

  it("queues the job for a sealed wrapped session", async () => {
    const { summarize, dispatch } = harness({});
    await expect(summarize({ runId: TACHO_ID }, ctx())).resolves.toEqual({
      runId: TACHO_ID,
      status: "queued",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("refuses a Viewer and a user with no org role, before any read (negative)", async () => {
    for (const role of ["Viewer", null]) {
      const { summarize, dispatch } = harness({ role });
      await expect(summarize({ runId: LEDGER_ID }, ctx())).rejects.toSatisfy(
        (e) => isHandlerError(e) && e.code === "forbidden",
      );
      expect(dispatch).not.toHaveBeenCalled();
    }
  });

  it("refuses a live run: nothing is summarised before the seal (negative)", async () => {
    const ledger = harness({
      ledger: {
        publicId: LEDGER_ID,
        runId: RUN_UUID,
        run: {
          ...ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID }).run,
          status: "running",
        },
        seal: null,
      },
    });
    await expect(
      ledger.summarize({ runId: LEDGER_ID }, ctx()),
    ).rejects.toSatisfy(conflict("run_not_sealed"));
    expect(ledger.dispatch).not.toHaveBeenCalled();

    const wrapped = harness({ session: { outcome: "running" } });
    await expect(
      wrapped.summarize({ runId: TACHO_ID }, ctx()),
    ).rejects.toSatisfy(conflict("run_not_sealed"));
    expect(wrapped.dispatch).not.toHaveBeenCalled();
  });

  it("refuses a digest_only recording on either store: a summary from receipts alone would stand in for the record (negative)", async () => {
    const ledger = harness({
      ledger: {
        publicId: LEDGER_ID,
        runId: RUN_UUID,
        seal: seal(RUN_UUID, {
          replayGrade: "inspect",
          completenessGaps: ["digest_only"],
        }),
      },
    });
    await expect(
      ledger.summarize({ runId: LEDGER_ID }, ctx()),
    ).rejects.toSatisfy(conflict("digest_only"));
    expect(ledger.dispatch).not.toHaveBeenCalled();

    const wrapped = harness({
      session: { replayGrade: "inspect", completenessGaps: ["digest_only"] },
    });
    await expect(
      wrapped.summarize({ runId: TACHO_ID }, ctx()),
    ).rejects.toSatisfy(conflict("digest_only"));
    expect(wrapped.dispatch).not.toHaveBeenCalled();
  });

  it("queues a run graded inspect for a gap other than digest_only: the bodies it kept are readable", async () => {
    const { summarize, dispatch } = harness({
      ledger: {
        publicId: LEDGER_ID,
        runId: RUN_UUID,
        seal: seal(RUN_UUID, {
          replayGrade: "inspect",
          completenessGaps: ["unobserved_tail"],
        }),
      },
    });
    await expect(summarize({ runId: LEDGER_ID }, ctx())).resolves.toMatchObject(
      { status: "queued" },
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("is not_found for a run outside the workspace (negative)", async () => {
    const { summarize, dispatch } = harness({});
    await expect(summarize({ runId: "arun_nope" }, ctx())).rejects.toSatisfy(
      (e) => isHandlerError(e) && e.code === "not_found",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
});
