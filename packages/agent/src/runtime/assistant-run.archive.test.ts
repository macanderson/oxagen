/**
 * The run store `openAssistantRun` builds when the caller injects none.
 *
 * Its own suite because it is the ONE thing `assistant-run.test.ts` cannot
 * observe: every case there passes `store: ledger.store`, so the default
 * branch — the one production takes — was never constructed in a test. It
 * shipped with no archive, and because a missing archive is refused at SEAL
 * rather than at construction, the failure landed at the end of a turn that
 * had already answered and already billed. The person saw "the assistant
 * could not be reached"; the ledger saw `run_store_state_invalid`.
 *
 * The assertion is on the ARGUMENT, not on a completed turn: the store is
 * built on the first line of `openAssistantRun`, so the call reaches it and
 * then fails on the identity read, which is fine. What matters is what the
 * ledger was handed.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPostgresRunStore: vi.fn(
    (_options?: { archive?: unknown }) => ({}) as never,
  ),
}));

vi.mock("@oxagen/run-ledger", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/run-ledger")>();
  return { ...real, createPostgresRunStore: mocks.createPostgresRunStore };
});
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const withTenantDb = vi.fn(() => {
    throw new Error("identity read not wired in this suite");
  });
  return { ...real, withTenantDb, withOrgDb: withTenantDb };
});
vi.mock("@oxagen/iam", () => ({
  createAgentRunAuthorizationSnapshot: vi.fn(),
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

import { openAssistantRun } from "./assistant-run";

describe("openAssistantRun: the default run store", () => {
  it("builds a store that carries an archive, because this recorder seals", async () => {
    await openAssistantRun({
      orgId: "org-1",
      workspaceId: "ws-1",
      userId: "user-1",
      originMessageId: null,
      surface: "chat",
      instruction: "anything",
      maxSteps: 4,
      toolAllowlist: [],
    }).catch(() => undefined);

    expect(mocks.createPostgresRunStore).toHaveBeenCalledTimes(1);
    const options = mocks.createPostgresRunStore.mock.calls[0]?.[0];
    // A store with no archive throws at seal — after the model has answered
    // and the tokens are spent. Constructing one here is the defect.
    expect(options?.archive).toBeDefined();
  });
});
