// The actor the work intake handlers record (P1-05, #5163; a defect P1-03
// left). assertContractRole answers the role that passed the check, such as
// "Owner". create_work_item, revise_work_triage, and set_work_collector once
// stored that answer as the actor, so a role name reached uuid columns
// (created_by_id, updated_by_id) and triage_corrections.by. Each handler now
// checks the role and then records the user the call acts as.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { effectiveTriage } from "@oxagen/work";

const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  resolveActingUserId: vi.fn(),
}));
vi.mock("./lib/capability-role-guard", () => ({ assertContractRole: mocks.role }));
vi.mock("@oxagen/iam/org-role", () => ({ assertOrgRole: vi.fn(), resolveActingUserId: mocks.resolveActingUserId }));

import type { CollectorView } from "./lib/work-intake/collectors";
import { createWorkCollectorSetHandler } from "./work.collector.set";
import { createWorkItemCreateHandler } from "./work.item.create";
import { createWorkTriageReviseHandler } from "./work.triage.revise";

const USER = "00000000-0000-4000-8000-000000000003";
const KEY_CREATOR = "00000000-0000-4000-8000-000000000004";
const person = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: USER,
  apiKeyId: null,
} as unknown as CapabilityContext;
const apiKey = { ...person, userId: null, apiKeyId: "aky_1" } as unknown as CapabilityContext;
/**
 * A user-bound key, such as an `oxagen login` key: the API sets both the key
 * and the user it resolves to (apps/api/src/middleware/auth.ts).
 */
const loginKey = { ...person, apiKeyId: "aky_2" } as unknown as CapabilityContext;
const nobody = { ...person, userId: null, apiKeyId: null } as unknown as CapabilityContext;

const VIEW: CollectorView = {
  collector_id: "00000000-0000-4000-8000-0000000000c1",
  name: "github",
  type: "github",
  connection_id: "con_01",
  repos: ["acme/web"],
  health: "healthy",
  cursor: null,
  last_reconcile: null,
  last_success_at: null,
  failed_streak: 0,
  next_check_at: null,
  last_event_at: null,
  created_at: "2026-10-02T12:00:00.000Z",
};

const REVISED = {
  item: { id: "row-1", publicId: "wi_01", number: "WI-1" },
  version: 5,
  state: "triaged" as const,
  changed: ["priority" as const],
  view: effectiveTriage(null, null, []),
  standing: { outcome: "triaged" as const, by: "oxagen" as const, decision: "tri_1", duplicateOf: null },
};

function enterDeps() {
  return {
    enter: vi.fn(async () => ({ id: "row-1", publicId: "wi_01", number: "WI-4", state: "new" as const, revision: 1, version: 1 })),
    send: vi.fn(async () => undefined),
  };
}

function reviseDeps() {
  return { revise: vi.fn(async () => REVISED) };
}

function collectorDeps() {
  return {
    set: vi.fn(async () => ({ result: { collectorId: VIEW.collector_id, created: true, reconcile: false }, view: VIEW })),
    send: vi.fn(async () => undefined),
    now: () => new Date("2026-10-02T12:00:00.000Z"),
  };
}

beforeEach(() => {
  mocks.role.mockReset();
  // The guard answers the role name that passed, as assertOrgRole does.
  mocks.role.mockResolvedValue("Owner");
  mocks.resolveActingUserId.mockReset();
  mocks.resolveActingUserId.mockImplementation(async (ctx: { userId: string | null; apiKeyId: string | null }) =>
    ctx.userId ?? (ctx.apiKeyId ? KEY_CREATOR : null),
  );
});

describe("create_work_item records the person, not the role", () => {
  it("passes the signed-in user's id to the store", async () => {
    const deps = enterDeps();
    await createWorkItemCreateHandler(deps)({ subject: "Fix invites", labels: [] }, person);
    expect(deps.enter).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorUserId: USER }));
    expect(deps.enter).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorUserId: "Owner" }));
  });

  it("records an API key's creator as the actor", async () => {
    const deps = enterDeps();
    await createWorkItemCreateHandler(deps)({ subject: "Fix invites", labels: [] }, apiKey);
    expect(deps.enter).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorUserId: KEY_CREATOR }));
  });

  it("refuses a call that names no person, before it writes", async () => {
    const deps = enterDeps();
    await expect(createWorkItemCreateHandler(deps)({ subject: "Fix invites", labels: [] }, nobody)).rejects.toMatchObject({
      code: "forbidden",
      reason: "person_required",
    });
    expect(deps.enter).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });
});

describe("revise_work_triage records the person, not the role", () => {
  const input = { item_id: "wi_01", expected_version: 4, reason: "A paying customer", priority: "P0" as const };

  it("passes the signed-in user's id as the correction's author", async () => {
    const deps = reviseDeps();
    await createWorkTriageReviseHandler(deps)(input, person);
    expect(deps.revise).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorUserId: USER }));
  });

  it("refuses a call that names no person, before it writes", async () => {
    const deps = reviseDeps();
    await expect(createWorkTriageReviseHandler(deps)(input, nobody)).rejects.toMatchObject({
      code: "forbidden",
      reason: "person_required",
    });
    expect(deps.revise).not.toHaveBeenCalled();
  });
  it("lets an API key's creator correct a field", async () => {
    const deps = reviseDeps();
    await createWorkTriageReviseHandler(deps)(input, apiKey);
    expect(deps.revise).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorUserId: KEY_CREATOR }));
  });

  it("refuses an API key that changes triage's outcome, before it writes", async () => {
    const deps = reviseDeps();
    await expect(
      createWorkTriageReviseHandler(deps)({ item_id: "wi_01", expected_version: 4, reason: "Not ours", outcome: "out_of_scope" }, apiKey),
    ).rejects.toMatchObject({ code: "forbidden", reason: "person_required" });
    expect(deps.revise).not.toHaveBeenCalled();
  });

  it("refuses an agent run, before it writes", async () => {
    const deps = reviseDeps();
    const agentRun = { ...person, agentRun: { runId: "arun_01" } } as unknown as CapabilityContext;
    await expect(createWorkTriageReviseHandler(deps)(input, agentRun)).rejects.toMatchObject({
      code: "forbidden",
      reason: "agent_run",
    });
    expect(deps.revise).not.toHaveBeenCalled();
  });
});

describe("set_work_collector records the person, not the role", () => {
  const input = { name: "github", connection_id: "con_01", repos: ["acme/web"] };

  it("passes the signed-in user's id to the collector store", async () => {
    const deps = collectorDeps();
    await createWorkCollectorSetHandler(deps)(input, person);
    expect(deps.set).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorUserId: USER }));
  });

  it("refuses a call that names no person, before it writes", async () => {
    const deps = collectorDeps();
    await expect(createWorkCollectorSetHandler(deps)(input, nobody)).rejects.toMatchObject({
      code: "forbidden",
      reason: "person_required",
    });
    expect(deps.set).not.toHaveBeenCalled();
  });
});

// Mac's decision on #5181 (2026-10-02): an agent may file work items, but only
// a person may change collectors. create_work_item above still records an API
// key's creator. set_work_collector refuses the key and an agent run before
// the role check and before any write.
describe("set_work_collector takes only a signed-in person", () => {
  const input = { name: "github", connection_id: "con_01", repos: ["acme/web"] };

  it.each([
    ["a key that names no user", apiKey],
    ["a login key that resolves to a person", loginKey],
  ])("refuses an API key, %s, before it writes", async (_name, ctx) => {
    const deps = collectorDeps();
    await expect(createWorkCollectorSetHandler(deps)(input, ctx)).rejects.toMatchObject({
      code: "forbidden",
      reason: "person_required",
    });
    expect(mocks.role).not.toHaveBeenCalled();
    expect(mocks.resolveActingUserId).not.toHaveBeenCalled();
    expect(deps.set).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("refuses an agent run, before it writes", async () => {
    const deps = collectorDeps();
    const agentRun = { ...person, agentRun: { runId: "arun_01" } } as unknown as CapabilityContext;
    await expect(createWorkCollectorSetHandler(deps)(input, agentRun)).rejects.toMatchObject({
      code: "forbidden",
      reason: "agent_run",
    });
    expect(mocks.role).not.toHaveBeenCalled();
    expect(deps.set).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("refuses an agent run that carries an API key as an agent run", async () => {
    const deps = collectorDeps();
    const keyedRun = { ...apiKey, agentRun: { runId: "arun_02" } } as unknown as CapabilityContext;
    await expect(createWorkCollectorSetHandler(deps)(input, keyedRun)).rejects.toMatchObject({ reason: "agent_run" });
    expect(deps.set).not.toHaveBeenCalled();
  });

  it("lets a signed-in person set up a collector", async () => {
    const deps = collectorDeps();
    const out = await createWorkCollectorSetHandler(deps)(input, person);
    expect(mocks.role).toHaveBeenCalledTimes(1);
    expect(deps.set).toHaveBeenCalledWith(
      { orgId: person.orgId, workspaceId: person.workspaceId },
      { name: "github", connectionId: "con_01", repos: ["acme/web"], actorUserId: USER },
    );
    expect(out).toEqual({ collector: VIEW, created: true, reconcile_queued: false });
  });
});
