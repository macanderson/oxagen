// get_change_set (ADR-292): the handler resolves a scope through its read,
// and an id that does not fit its scope, or a scope with no row, is not_found.
import { describe, expect, it, vi } from "vitest";
import {
  type ChangeSetGetDeps,
  createGetChangeSetHandler,
} from "./forge.changes.get";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const ctx = SCOPE as unknown as Parameters<
  ReturnType<typeof createGetChangeSetHandler>
>[1];

const EMPTY = { pullRequests: [], morePullRequests: false, repositories: [] };

describe("get_change_set", () => {
  it.each([
    ["run", "tse_4q8r1t6v3x5z0b2d7h2k9m"],
    ["run", "arun_5f0c2e9a1b7d4c3e8f6a02"],
    ["work_order", "wo_7Hk2"],
    ["work_item", "wi_3Jq9"],
    ["issue", "https://github.com/acme/api/issues/7"],
    ["issue", "https://gitlab.com/acme/platform/web/-/issues/12"],
  ] as const)("reads a %s by its id (%s)", async (scope, id) => {
    const read = vi.fn<ChangeSetGetDeps["read"]>(async () => ({
      scope,
      id,
      ...EMPTY,
    }));
    await expect(
      createGetChangeSetHandler({ read })({ scope, id }, ctx),
    ).resolves.toEqual({ scope, id, ...EMPTY });
    expect(read).toHaveBeenCalledWith(SCOPE, scope, id);
  });

  it.each([
    ["run", "wo_7Hk2"],
    ["work_order", "tse_4q8r1t6v3x5z0b2d7h2k9m"],
    ["work_item", "https://github.com/acme/api/issues/7"],
    ["issue", "https://github.com/acme/api/pull/7"],
    ["issue", "http://github.com/acme/api/issues/7"],
  ] as const)(
    "refuses a %s id that does not fit the scope (%s) without reading (negative)",
    async (scope, id) => {
      const read = vi.fn<ChangeSetGetDeps["read"]>();
      await expect(
        createGetChangeSetHandler({ read })({ scope, id }, ctx),
      ).rejects.toMatchObject({ code: "not_found", reason: `${scope}_not_found` });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("is not_found when the work order is not in the workspace (negative)", async () => {
    await expect(
      createGetChangeSetHandler({ read: async () => "not_found" })(
        { scope: "work_order", id: "wo_7Hk2" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "not_found", reason: "work_order_not_found" });
  });
});
