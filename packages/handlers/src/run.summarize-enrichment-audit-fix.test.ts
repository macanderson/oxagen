/**
 * summarize_run in a workspace that turned run enrichment off. The job
 * writes no summary there, so answering `queued` promised one that never
 * came; the handler refuses with `conflict` / `enrichment_disabled` instead.
 */
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  createRunSummarizeHandler,
  type RunSummarizeDeps,
} from "./run.summarize";
import {
  ctx,
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

function harness(enabled: boolean | undefined) {
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(roleTx("Member"))),
  );
  const stores = memoryStores(
    [
      ledgerRun({
        publicId: LEDGER_ID,
        runId: RUN_UUID,
        seal: seal(RUN_UUID),
      }),
    ],
    [tachoSession({ publicId: TACHO_ID })],
  );
  const dispatch = vi.fn(() => Promise.resolve());
  const deps: RunSummarizeDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: (id) =>
        Promise.resolve(id === LEDGER_ID ? summary() : null),
      readAttemptEventsSince: memoryEvents([]),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: memoryTachoFrames("none", []),
    ...(enabled === undefined
      ? {}
      : { readEnrichmentEnabled: () => Promise.resolve(enabled) }),
    dispatch,
  };
  return { summarize: createRunSummarizeHandler(deps), dispatch };
}

const conflict = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "conflict" && e.reason === reason;

describe("summarize_run with run enrichment off", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([LEDGER_ID, TACHO_ID])(
    "refuses %s with enrichment_disabled and queues nothing",
    async (runId) => {
      const { summarize, dispatch } = harness(false);
      await expect(summarize({ runId }, ctx())).rejects.toSatisfy(
        conflict("enrichment_disabled"),
      );
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("queues the job when the setting is on", async () => {
    const { summarize, dispatch } = harness(true);
    await expect(summarize({ runId: LEDGER_ID }, ctx())).resolves.toEqual({
      runId: LEDGER_ID,
      status: "queued",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("still answers not_found for a run outside the workspace first", async () => {
    const { summarize } = harness(false);
    await expect(
      summarize({ runId: "arun_0000000000000000000000" }, ctx()),
    ).rejects.toSatisfy((e) => isHandlerError(e) && e.code === "not_found");
  });
});
