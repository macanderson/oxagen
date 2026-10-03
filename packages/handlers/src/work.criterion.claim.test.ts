// The caller gate on claim_work_criterion (ADR-244, ADR-251): only the agent
// working a send may claim a criterion, as its run or through the key of the
// host running it. A person and any other key are refused before anything is
// read, and a work record refusal reaches the caller in the shape the surfaces
// read. claims.pg.test.ts proves the binding to the linked run on Postgres.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { WorkRecordError } from "@oxagen/work/records";
import { workCriterionClaim } from "@oxagen/oxagen/contracts/work.criterion.claim";

const mocks = vi.hoisted(() => ({
  assertContractRole: vi.fn(),
  resolveEnrolledHost: vi.fn(),
  claimWorkCriterion: vi.fn(),
}));
vi.mock("./lib/capability-role-guard", () => ({ assertContractRole: mocks.assertContractRole }));
vi.mock("./lib/tacho-host", () => ({ resolveEnrolledHost: mocks.resolveEnrolledHost }));
vi.mock("./lib/work-records/claims", () => ({ claimWorkCriterion: mocks.claimWorkCriterion }));
vi.mock("@oxagen/iam/machine-key-scope", () => ({ TACHO_HOST_PURPOSE: "tacho_host_v1", readKeyScope: vi.fn() }));

import { createWorkCriterionClaimHandler, type WorkCriterionClaimDeps } from "./work.criterion.claim";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const HOST = "tch_0123456789abcdefghjkmn";
const RUN = "tse_run1";
const person: CapabilityContext = { orgId: ORG, workspaceId: WS, userId: "user_1", apiKeyId: null, requestId: "r", surface: "app", messageId: null };
const apiKey: CapabilityContext = { ...person, userId: null, apiKeyId: "aky_1", surface: "api" };
const agentRun = { ...person, userId: null, agentRun: { principalKind: "agent", runId: RUN } } as unknown as CapabilityContext;

const INPUT = workCriterionClaim.input.parse({
  item_id: "wi_abc",
  work_order_id: "wo_1",
  criterion_id: "c1",
  head_sha: "1".repeat(40),
  text: "The invite test covers the expired link.",
});

const ANSWER = {
  item: { id: "wi_abc", state: "review", revision: 1, version: 7 },
  repeat: false,
  order: { id: "wo_1", send: 1, key: "wi_abc:r1:s1", delivery: "run_ended" },
  claim: { criterion_id: "c1", head_sha: "1".repeat(40), run_id: RUN },
};

const TX = { tx: true };

function deps() {
  const d = {
    db: vi.fn(async (fn: (tx: never) => Promise<unknown>) => fn(TX as never)),
    keyScope: vi.fn(async () => ({ kind: "purpose", purpose: "tacho_host_v1", hostEnrollmentId: HOST })),
    now: () => new Date("2026-10-03T10:00:00Z"),
  };
  return { d, handler: createWorkCriterionClaimHandler(d as unknown as WorkCriterionClaimDeps) };
}

beforeEach(() => {
  mocks.assertContractRole.mockReset();
  mocks.assertContractRole.mockResolvedValue("Owner");
  mocks.resolveEnrolledHost.mockReset();
  mocks.resolveEnrolledHost.mockResolvedValue({ id: "host-row", publicId: HOST, runtimeId: "rt-1", agentId: "agent-1" });
  mocks.claimWorkCriterion.mockReset();
  mocks.claimWorkCriterion.mockResolvedValue(ANSWER);
});

describe("claim_work_criterion caller gate", () => {
  it("refuses a signed-in person before it reads anything", async () => {
    const { d, handler } = deps();
    await expect(handler(INPUT, person)).rejects.toMatchObject({ code: "forbidden", reason: "agent_required" });
    expect(d.keyScope).not.toHaveBeenCalled();
    expect(mocks.assertContractRole).not.toHaveBeenCalled();
    expect(d.db).not.toHaveBeenCalled();
  });

  it.each([
    ["a person's own key", { kind: "personal" }],
    ["a key that was revoked mid-request", { kind: "missing" }],
    ["a gateway key", { kind: "purpose", purpose: "tacho_gateway_v1", hostEnrollmentId: HOST }],
    ["a CLI login key", { kind: "purpose", purpose: "cli_session_v1" }],
    ["a host key that names no host", { kind: "purpose", purpose: "tacho_host_v1" }],
  ])("refuses %s before it opens a transaction", async (_name, scope) => {
    const { d, handler } = deps();
    d.keyScope.mockResolvedValueOnce(scope as never);
    await expect(handler(INPUT, apiKey)).rejects.toMatchObject({ code: "forbidden", reason: "agent_required" });
    expect(d.keyScope).toHaveBeenCalledWith(ORG, "aky_1");
    expect(mocks.assertContractRole).not.toHaveBeenCalled();
    expect(d.db).not.toHaveBeenCalled();
  });

  it("files an agent run's claim as that run, checked against the send in the store", async () => {
    const { d, handler } = deps();
    await expect(handler(INPUT, agentRun)).resolves.toEqual(ANSWER);
    expect(d.keyScope).not.toHaveBeenCalled();
    expect(mocks.resolveEnrolledHost).not.toHaveBeenCalled();
    expect(mocks.claimWorkCriterion).toHaveBeenCalledWith(
      TX,
      { orgId: ORG, workspaceId: WS },
      { kind: "run", runId: RUN },
      INPUT,
      new Date("2026-10-03T10:00:00Z"),
    );
  });

  it("refuses a run that is not the send's linked run, as forbidden", async () => {
    const { handler } = deps();
    mocks.claimWorkCriterion.mockRejectedValueOnce(new WorkRecordError("forbidden", "This run is not the run working send 1."));
    await expect(handler(INPUT, agentRun)).rejects.toMatchObject({ code: "forbidden", reason: "forbidden" });
  });

  it("resolves the host a host key names, checks the key creator's role, and claims as that host", async () => {
    const { d, handler } = deps();
    await expect(handler(INPUT, apiKey)).resolves.toEqual(ANSWER);
    expect(mocks.assertContractRole).toHaveBeenCalledWith(workCriterionClaim, apiKey);
    expect(mocks.resolveEnrolledHost).toHaveBeenCalledWith("claim_work_criterion", apiKey, TX, HOST);
    expect(d.db).toHaveBeenCalledTimes(1);
    expect(mocks.claimWorkCriterion).toHaveBeenCalledWith(
      TX,
      { orgId: ORG, workspaceId: WS },
      { kind: "host", host: { id: "host-row", publicId: HOST, runtimeId: "rt-1", agentId: "agent-1" } },
      INPUT,
      new Date("2026-10-03T10:00:00Z"),
    );
  });

  it("stops at a refused role before it opens a transaction", async () => {
    const { d, handler } = deps();
    mocks.assertContractRole.mockRejectedValueOnce(Object.assign(new Error("no role"), { code: "forbidden", reason: "org_role_required" }));
    await expect(handler(INPUT, apiKey)).rejects.toMatchObject({ reason: "org_role_required" });
    expect(d.db).not.toHaveBeenCalled();
  });

  it("passes a refused host through unchanged", async () => {
    const { handler } = deps();
    const refused = Object.assign(new Error("Forbidden: Tacho host enrollment revoked"), { code: "forbidden", reason: "host_revoked" });
    mocks.resolveEnrolledHost.mockRejectedValueOnce(refused);
    await expect(handler(INPUT, apiKey)).rejects.toBe(refused);
    expect(mocks.claimWorkCriterion).not.toHaveBeenCalled();
  });

  it.each([
    ["stale_head", { code: "conflict", reason: "stale_head" }],
    ["stale_revision", { code: "conflict", reason: "stale_revision" }],
    ["not_allowed", { code: "conflict", reason: "not_allowed" }],
    ["not_found", { code: "not_found", reason: "not_found" }],
    ["invalid_input", { code: "invalid_input", capability: "claim_work_criterion" }],
  ] as const)("answers a %s refusal in the shape the surfaces read", async (code, shape) => {
    const { handler } = deps();
    mocks.claimWorkCriterion.mockRejectedValueOnce(new WorkRecordError(code, `Refused: ${code}.`));
    await expect(handler(INPUT, apiKey)).rejects.toMatchObject({ ...shape, message: `Refused: ${code}.` });
  });
});
