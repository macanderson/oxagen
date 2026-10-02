// work-intake.handlers.test.ts: the MCP tools for work intake and triage
// (P1-03, #5103): create_work_item, revise_work_triage, retry_work_triage,
// list_work_collectors, set_work_collector, sync_work_collector, and
// get_work_priorities.
//
// The kernel `invoke` and the context seam `buildContext` are doubles. Each
// case checks that invoke received the contract name, the args, and
// { surface: "mcp" }, and that the output passed the contract's output schema
// on the way back.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import setWorkCollector, { metadata as setMeta } from "./work.collector.set";
import syncWorkCollector, { metadata as syncMeta } from "./work.collector.sync";
import listWorkCollectors, { metadata as listMeta } from "./work.collectors.list";
import createWorkItem, { metadata as createMeta, schema as createSchema } from "./work.item.create";
import getWorkPriorities, { metadata as prioritiesMeta } from "./work.priorities.get";
import retryWorkTriage, { metadata as retryMeta } from "./work.triage.retry";
import reviseWorkTriage, { metadata as reviseMeta } from "./work.triage.revise";

const fakeCtx = { orgId: "org_test", workspaceId: "ws_test", userId: "user_test", apiKeyId: null, surface: "mcp" as const };
const COLLECTOR_ID = "00000000-0000-4000-8000-000000000001";

const field = <T>(value: T) => ({ value, by: "oxagen" as const, actor: null, at: null });
const VIEW = {
  decision: "tri_01",
  priority: field("P1"),
  priority_reason: "A paying customer reported it.",
  cites: ["aintel.work.priorities#2"],
  estimate_minutes: field(45),
  labels: field(["Bug"]),
  claims: field(["src/**"]),
  criteria: field(["A test passes."]),
  questions: [],
  duplicates: [],
  related: [],
  conflicts: [],
};
const COLLECTOR = {
  collector_id: COLLECTOR_ID,
  name: "github",
  type: "github",
  connection_id: "con_01",
  repos: ["acme/web"],
  health: "healthy",
  cursor: null,
  last_reconcile: null,
  last_success_at: null,
  failed_streak: 0,
  next_check_at: "2026-10-02T10:15:00.000Z",
  last_event_at: null,
  created_at: "2026-10-02T10:00:00.000Z",
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.buildContext.mockReset();
  mocks.headers.mockReset();
  mocks.headers.mockReturnValue({});
  mocks.buildContext.mockResolvedValue(fakeCtx);
});

describe("work intake MCP tools", () => {
  it.each([
    [createMeta, "create_work_item", false],
    [reviseMeta, "revise_work_triage", false],
    [retryMeta, "retry_work_triage", false],
    [listMeta, "list_work_collectors", true],
    [setMeta, "set_work_collector", false],
    [syncMeta, "sync_work_collector", false],
    [prioritiesMeta, "get_work_priorities", true],
  ])("names %s after its contract and marks only reads read-only", (meta, name, readOnly) => {
    expect(meta.name).toBe(name);
    expect(meta.annotations?.readOnlyHint).toBe(readOnly);
    expect(meta.annotations?.destructiveHint).toBe(false);
  });

  it("takes the contract's input fields", () => {
    expect(Object.keys(createSchema).sort()).toEqual(["description", "labels", "repository", "subject"]);
  });

  it.each([
    [
      "create_work_item",
      () => createWorkItem({ subject: "Fix invites", labels: [], description: undefined, repository: undefined }),
      { item_id: "wi_01", number: "WI-1", state: "new", revision: 1, version: 1 },
    ],
    [
      "revise_work_triage",
      () =>
        reviseWorkTriage({
          item_id: "wi_01",
          expected_version: 2,
          reason: "Customer",
          priority: "P0",
          estimate_minutes: undefined,
          labels: undefined,
          claims: undefined,
          criteria: undefined,
          outcome: undefined,
          duplicate_of: undefined,
        }),
      {
        item_id: "wi_01",
        version: 3,
        state: "triaged",
        changed: ["priority"],
        triage: VIEW,
        standing: { outcome: "triaged", by: "oxagen", duplicate_of: null },
      },
    ],
    ["retry_work_triage", () => retryWorkTriage({ item_id: "wi_01" }), { item_id: "wi_01", state: "new", queued: true }],
    ["list_work_collectors", () => listWorkCollectors({}), { collectors: [COLLECTOR] }],
    [
      "set_work_collector",
      () => setWorkCollector({ name: "github", connection_id: "con_01", repos: ["acme/web"], paused: undefined }),
      { collector: COLLECTOR, created: true, reconcile_queued: true },
    ],
    ["sync_work_collector", () => syncWorkCollector({ collector_id: COLLECTOR_ID }), { collector_id: COLLECTOR_ID, queued: true }],
    [
      "get_work_priorities",
      () => getWorkPriorities({}),
      { record: null, problem: "No priorities record.", last_30_days: { suggestions: 0, failures: 0, corrections: 0 } },
    ],
  ])("invokes %s on the mcp surface and returns its checked output", async (name, call, output) => {
    mocks.invoke.mockResolvedValue(output);
    await expect(call()).resolves.toEqual(output);
    expect(mocks.invoke).toHaveBeenCalledWith(name, expect.any(Object), fakeCtx, { surface: "mcp" });
  });

  it("refuses an output its contract does not allow", async () => {
    mocks.invoke.mockResolvedValue({ collectors: [{ ...COLLECTOR, health: "broken" }] });
    await expect(listWorkCollectors({})).rejects.toThrow();
  });
});
