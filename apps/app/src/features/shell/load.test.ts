import { describe, expect, it, vi } from "vitest";
import { liveShell } from "@/data/adapters/live/shell";
import { FIXTURE_TENANT } from "@/data/fixture-tenant";
import { notBacked, readError } from "@/data/not-backed";
import type { ShellReadPort } from "@/data/ports";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { testFixtureShell } from "@/data/adapters/fixture/testing";
import { FIXTURE_USER } from "@/server/fixture-session";
import { loadShellData, workspaceExists } from "./load";

const scope = {
  orgId: FIXTURE_TENANT.orgId,
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};
const query = { org: "acme", scope, userId: FIXTURE_USER.id };

describe("loadShellData", () => {
  it("loads every read for a member's organization, asking each once with the viewer's scope", async () => {
    const port = testFixtureShell();
    const spies = Object.fromEntries(
      Object.keys(port).map((k) => [
        k,
        vi.spyOn(port, k as keyof ShellReadPort),
      ]),
    );
    const load = await loadShellData(port, query);
    expect(load.kind).toBe("ok");
    if (load.kind !== "ok") return;
    expect(load.data.org).toBe("acme");
    expect(load.data.context.ok).toBe(true);
    expect(load.data.runs.length).toBeGreaterThan(0);
    expect(spies.people).not.toHaveBeenCalled();
    for (const [name, spy] of Object.entries(spies)) {
      if (name === "people") continue;
      expect(spy, name).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0], name).toEqual(scope);
    }
    expect(spies.account).toHaveBeenCalledWith(scope, FIXTURE_USER.id);
  });

  it("is not found when the organization read is a 404", async () => {
    expect(
      await loadShellData(testFixtureShell(), {
        ...query,
        scope: { ...scope, orgId: "7f1c2a9e-0000-4000-8000-000000000000" },
      }),
    ).toEqual({ kind: "not_found" });
    expect(
      await loadShellData(testFixtureShell(), {
        ...query,
        userId: "usr_someoneelse",
      }),
    ).toEqual({ kind: "not_found" });
  });

  it("keeps any other context failure as a failure the shell renders, not a 404", async () => {
    const load = await loadShellData(liveShell, query);
    expect(load.kind).toBe("ok");
    if (load.kind !== "ok") return;
    expect(load.data.context).toMatchObject({
      ok: false,
      reason: "not_backed",
    });
    expect(load.data.runs).toEqual([]);

    const erroredContext: ShellReadPort = {
      ...liveShell,
      context: () =>
        Promise.resolve(readError("control_plane_unavailable", 503)),
    };
    expect((await loadShellData(erroredContext, query)).kind).toBe("ok");
    const notBackedContext: ShellReadPort = {
      ...liveShell,
      context: () => Promise.resolve(notBacked("M1", "G15")),
    };
    expect((await loadShellData(notBackedContext, query)).kind).toBe("ok");
  });
});

describe("workspaceExists", () => {
  it("knows the organization's workspaces", async () => {
    const context = await testFixtureShell().context(scope, FIXTURE_USER.id);
    expect(workspaceExists({ context }, "core-platform")).toBe(true);
    expect(workspaceExists({ context }, "nope")).toBe(false);
  });

  it("does not guess when the context read failed", () => {
    expect(
      workspaceExists({ context: readError("x", 501) }, "core-platform"),
    ).toBe("unknown");
  });
});
