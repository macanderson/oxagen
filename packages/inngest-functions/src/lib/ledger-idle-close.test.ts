import {
  AttemptAdvancedError,
  type IdleLedgerAttempt,
} from "@oxagen/run-ledger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ scopes: [] as unknown[] }));
vi.mock("@oxagen/tenancy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/tenancy")>()),
  runInTenantScope: (scope: unknown, fn: () => unknown) => {
    mocks.scopes.push(scope);
    return fn();
  },
}));

import {
  closeIdleLedgerAttempt,
  LEDGER_IDLE_CLOSE_ERROR,
  LEDGER_IDLE_CLOSE_SEALER,
} from "./ledger-idle-close";

const ORG = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const WS = "0192d4a8-7c1e-7a00-8000-0000000000a2";

const idle: IdleLedgerAttempt = {
  runId: "0192d4a8-7c1e-7a00-8000-0000000000c1",
  runPublicId: "arun_0123456789abcdef012345",
  orgId: ORG,
  workspaceId: WS,
  attemptId: "0192d4a8-7c1e-7a00-8000-0000000000d1",
  attemptPublicId: "arat_0123456789abcdef0123",
  lastAttemptSeq: 4,
  lastActivityAt: new Date("2026-09-23T20:00:00.000Z"),
};

function handle(alreadySealed: boolean) {
  return {
    runId: idle.runId,
    attemptId: idle.attemptId,
    attemptPublicId: idle.attemptPublicId,
    sealId: "seal-1",
    terminalStatus: "abandoned",
    grantId: "grant-1",
    grantPublicId: "afg_abc",
    submissionId: "afg_abc",
    obligationId: "obligation-1",
    eventCount: 4,
    finalEventDigest: null,
    eventStreamDigest: `sha256:${"a".repeat(64)}`,
    alreadySealed,
  };
}

const sealAttempt = vi.fn();
const store = { sealAttempt };

describe("closeIdleLedgerAttempt (#3988)", () => {
  beforeEach(() => {
    sealAttempt.mockReset();
    mocks.scopes.length = 0;
  });

  it("seals the attempt abandoned at the head the scan read, in its tenant", async () => {
    sealAttempt.mockResolvedValue(handle(false));
    await expect(closeIdleLedgerAttempt(idle, store)).resolves.toEqual({
      runPublicId: idle.runPublicId,
      orgId: ORG,
      workspaceId: WS,
    });
    expect(sealAttempt).toHaveBeenCalledWith({
      attemptId: idle.attemptId,
      terminalStatus: "abandoned",
      reasonCode: "idle_timeout",
      sealerId: LEDGER_IDLE_CLOSE_SEALER,
      error: LEDGER_IDLE_CLOSE_ERROR,
      expectedAttemptSeq: 4,
    });
    expect(mocks.scopes).toEqual([{ orgId: ORG, workspaceId: WS }]);
  });

  it("closes nothing when the producer appended after the scan", async () => {
    sealAttempt.mockRejectedValue(
      new AttemptAdvancedError(idle.attemptId, 4, 5),
    );
    await expect(closeIdleLedgerAttempt(idle, store)).resolves.toBeNull();
  });

  it("closes nothing when the producer sealed the attempt itself", async () => {
    sealAttempt.mockResolvedValue(handle(true));
    await expect(closeIdleLedgerAttempt(idle, store)).resolves.toBeNull();
  });

  it("throws any other failure, so the job logs it and tries next pass", async () => {
    const fault = new Error("lock timeout");
    sealAttempt.mockRejectedValue(fault);
    await expect(closeIdleLedgerAttempt(idle, store)).rejects.toBe(fault);
  });
});
