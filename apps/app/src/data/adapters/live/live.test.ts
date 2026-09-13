import { describe, expect, it } from "vitest";
import { allMethods } from "@/data/backing";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { liveSource } from "./index";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};

describe("live source before Batch 3", () => {
  it("implements every port method in the backing table, and no other", () => {
    const implemented = Object.entries(liveSource).flatMap(([port, methods]) =>
      Object.keys(methods as object).map((method) => `${port}.${method}`),
    );
    expect(implemented.sort()).toEqual(
      allMethods()
        .map((m) => `${m.port}.${m.method}`)
        .sort(),
    );
  });

  it.each(allMethods())(
    "$port.$method returns its milestone and gap, never a value",
    async ({ port, method, backing }) => {
      const target = liveSource[port] as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      await expect(target[method]?.(SCOPE, "id", "0")).resolves.toEqual({
        ok: false,
        reason: "not_backed",
        milestone: backing.milestone,
        gap: backing.gap,
      });
    },
  );
});
