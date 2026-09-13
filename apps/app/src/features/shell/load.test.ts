import { describe, expect, it, vi } from "vitest";
import { notBacked, readError } from "@/data/not-backed";
import { FIXTURE_USER } from "@/server/fixture-session";
import { fixtureShell } from "./adapters/fixture";
import { liveShell } from "./adapters/live";
import { DEFAULT_SWITCHES } from "./fixture-switches";
import { loadShellData, workspaceExists } from "./load";
import type { ShellReadPort } from "./port";

const query = { org: "acme", userId: FIXTURE_USER.id };

describe("loadShellData", () => {
  it("loads every read for a member's organization, asking each once", async () => {
    const port = fixtureShell(DEFAULT_SWITCHES);
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
    for (const spy of Object.values(spies)) {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ ...query, ws: null });
    }
  });

  it("is not found when the organization read is a 404", async () => {
    expect(
      await loadShellData(fixtureShell(DEFAULT_SWITCHES), {
        ...query,
        org: "globex",
      }),
    ).toEqual({
      kind: "not_found",
    });
  });

  it("keeps any other context failure as a failure the shell renders, not a 404", async () => {
    const load = await loadShellData(liveShell, query);
    expect(load.kind).toBe("ok");
    if (load.kind !== "ok") return;
    expect(load.data.context).toMatchObject({ ok: false, status: 501 });
    expect(load.data.runs).toEqual([]);

    const notBackedContext: ShellReadPort = {
      ...liveShell,
      context: () => Promise.resolve(notBacked("M1", "G15")),
    };
    expect((await loadShellData(notBackedContext, query)).kind).toBe("ok");
  });
});

describe("workspaceExists", () => {
  it("knows the organization's workspaces", async () => {
    const context = await fixtureShell(DEFAULT_SWITCHES).context({
      ...query,
      ws: null,
    });
    expect(workspaceExists({ context }, "core-platform")).toBe(true);
    expect(workspaceExists({ context }, "nope")).toBe(false);
  });

  it("does not guess when the context read failed", () => {
    expect(
      workspaceExists({ context: readError("x", 501) }, "core-platform"),
    ).toBe("unknown");
  });
});
