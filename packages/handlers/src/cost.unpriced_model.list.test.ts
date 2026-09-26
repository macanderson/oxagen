import { ORG_ONLY_WORKSPACE_ID, HandlerError } from "@oxagen/oxagen";
import { costUnpricedModelList } from "@oxagen/oxagen/contracts/cost.unpriced_model.list";
import type { UnpricedModel } from "@oxagen/billing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => gate);

import { createUnpricedModelListHandler } from "./cost.unpriced_model.list";
import { ctx, SCOPE } from "./spend.test-support";

const NOW = new Date("2026-09-14T15:00:00.000Z");
const THIRTY_DAYS_BEFORE_NOW = new Date("2026-08-15T15:00:00.000Z");

beforeEach(() => {
  gate.assertOrgRole.mockReset();
  gate.resolveActingUserId.mockReset();
  gate.resolveActingUserId.mockImplementation(
    async (c: { userId: string | null }) => c.userId,
  );
  gate.assertOrgRole.mockResolvedValue("Member");
});

const DEFAULT_WINDOWS = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "output",
].map((tokenClass) => ({
  tokenClass:
    tokenClass as UnpricedModel["missingClassWindows"][number]["tokenClass"],
  unpricedFrom: new Date("2026-09-02T09:00:00.000Z"),
  unpricedTo: new Date("2026-09-13T21:30:00.000Z"),
  calls: 0,
  units: 0,
}));

function model(over: Partial<UnpricedModel> = {}): UnpricedModel {
  return {
    model: "vendor/brand-new",
    provider: "vendor",
    calls: 12,
    tokens: 480_000,
    firstSeen: new Date("2026-09-02T09:00:00.000Z"),
    lastSeen: new Date("2026-09-13T21:30:00.000Z"),
    classes: [],
    missingClasses: [
      "input_uncached",
      "cache_read",
      "cache_write_5m",
      "output",
    ],
    missingClassWindows: DEFAULT_WINDOWS,
    fullyUnpriced: true,
    ...over,
  };
}

function harness(models: UnpricedModel[]) {
  const readUnpricedModels = vi.fn(async () => models);
  return {
    handler: createUnpricedModelListHandler({
      readUnpricedModels,
      now: () => NOW,
    }),
    readUnpricedModels,
  };
}

describe("list_unpriced_models", () => {
  it("refuses before any read when the actor lacks an allowed org role", async () => {
    gate.assertOrgRole.mockRejectedValueOnce(
      new HandlerError({ code: "forbidden", reason: "org_role_required" }),
    );
    const h = harness([]);
    await expect(h.handler({}, ctx())).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(h.readUnpricedModels).not.toHaveBeenCalled();
  });

  it("reads the last thirty days against the book as it stands now", async () => {
    const h = harness([]);
    const out = await h.handler({}, ctx());
    expect(h.readUnpricedModels).toHaveBeenCalledWith({
      orgId: SCOPE.orgId,
      workspaceId: SCOPE.workspaceId,
      since: THIRTY_DAYS_BEFORE_NOW,
      at: NOW,
    });
    expect(out).toEqual({
      since: THIRTY_DAYS_BEFORE_NOW.toISOString(),
      at: NOW.toISOString(),
      models: [],
    });
    expect(() => costUnpricedModelList.output.parse(out)).not.toThrow();
  });

  it("counts the window back from the instant the book is read at", async () => {
    // A caller asking what was unpriced in August wants August's book, and a
    // window that ends where that book was live — not one ending today.
    const h = harness([]);
    const out = await h.handler({ at: "2026-08-01T00:00:00.000Z" }, ctx());
    expect(h.readUnpricedModels).toHaveBeenCalledWith({
      orgId: SCOPE.orgId,
      workspaceId: SCOPE.workspaceId,
      since: new Date("2026-07-02T00:00:00.000Z"),
      at: new Date("2026-08-01T00:00:00.000Z"),
    });
    expect(out.since).toBe("2026-07-02T00:00:00.000Z");
  });

  it("refuses a reversed observation window before reading usage", async () => {
    const h = harness([]);
    await expect(
      h.handler(
        { since: "2026-09-02T00:00:00.000Z", at: "2026-09-01T00:00:00.000Z" },
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "unpriced_model_window_reversed",
    });
    expect(h.readUnpricedModels).not.toHaveBeenCalled();
    await h.handler({ since: NOW.toISOString(), at: NOW.toISOString() }, ctx());
    expect(h.readUnpricedModels).toHaveBeenCalledOnce();
  });

  it("honours an explicit window", async () => {
    const h = harness([]);
    await h.handler({ since: "2026-09-01T00:00:00.000Z" }, ctx());
    expect(h.readUnpricedModels).toHaveBeenCalledWith(
      expect.objectContaining({ since: new Date("2026-09-01T00:00:00.000Z") }),
    );
  });

  it("reads the whole organization when the mount carries no workspace", async () => {
    // The org-only mount's nil sentinel is a real workspace_id in the frame
    // stores: passing it through would answer "nothing unpriced" for every
    // organization whose frames name a real workspace.
    const h = harness([]);
    await h.handler({}, { ...ctx(), workspaceId: ORG_ONLY_WORKSPACE_ID });
    expect(h.readUnpricedModels).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: undefined }),
    );
  });

  it("answers each model with its window as instants and its missing classes", async () => {
    const h = harness([
      model(),
      model({
        model: "half-priced",
        provider: null,
        calls: 4,
        tokens: 900,
        missingClasses: ["cache_read"],
        missingClassWindows: [
          {
            tokenClass: "cache_read",
            unpricedFrom: new Date("2026-09-02T09:00:00.000Z"),
            unpricedTo: new Date("2026-09-13T21:30:00.000Z"),
            calls: 0,
            units: 0,
          },
        ],
        fullyUnpriced: false,
      }),
    ]);
    const out = await h.handler({}, ctx());
    expect(out.models).toEqual([
      {
        model: "vendor/brand-new",
        provider: "vendor",
        calls: 12,
        tokens: 480_000,
        firstSeen: "2026-09-02T09:00:00.000Z",
        lastSeen: "2026-09-13T21:30:00.000Z",
        missingClasses: [
          "input_uncached",
          "cache_read",
          "cache_write_5m",
          "output",
        ],
        missingClassWindows: DEFAULT_WINDOWS.map((w) => ({
          tokenClass: w.tokenClass,
          unpricedFrom: w.unpricedFrom.toISOString(),
          unpricedTo: w.unpricedTo.toISOString(),
          calls: w.calls,
          units: w.units,
        })),
        fullyUnpriced: true,
      },
      {
        model: "half-priced",
        provider: null,
        calls: 4,
        tokens: 900,
        firstSeen: "2026-09-02T09:00:00.000Z",
        lastSeen: "2026-09-13T21:30:00.000Z",
        missingClasses: ["cache_read"],
        missingClassWindows: [
          {
            tokenClass: "cache_read",
            unpricedFrom: "2026-09-02T09:00:00.000Z",
            unpricedTo: "2026-09-13T21:30:00.000Z",
            calls: 0,
            units: 0,
          },
        ],
        fullyUnpriced: false,
      },
    ]);
    expect(() => costUnpricedModelList.output.parse(out)).not.toThrow();
  });
});
