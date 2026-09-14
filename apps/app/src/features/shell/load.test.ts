import { describe, expect, it } from "vitest";
import { liveShell } from "@/data/adapters/live/shell";
import { notBacked, readError } from "@/data/not-backed";
import type { ShellReadPort } from "@/data/ports";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { loadShellData } from "./load";

const USER_ID = "usr_marcusbell";
const scope = {
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};
const query = { org: "acme", scope, userId: USER_ID };

const METHODS = [
  "context",
  "navCounts",
  "notifications",
  "people",
  "assistantEngine",
  "recentRuns",
  "account",
] as const;

type Method = (typeof METHODS)[number];

/** A port whose every read fails the same way, with each call recorded by method name. */
function failingPort(): {
  port: ShellReadPort;
  calls: Record<Method, unknown[][]>;
} {
  const calls: Record<Method, unknown[][]> = {
    context: [],
    navCounts: [],
    notifications: [],
    people: [],
    assistantEngine: [],
    recentRuns: [],
    account: [],
  };
  const method =
    (name: Method) =>
    (...args: unknown[]) => {
      calls[name].push(args);
      return Promise.resolve(readError("control_plane_unavailable", 503));
    };
  return {
    port: {
      context: method("context"),
      navCounts: method("navCounts"),
      notifications: method("notifications"),
      people: method("people"),
      assistantEngine: method("assistantEngine"),
      recentRuns: method("recentRuns"),
      account: method("account"),
    },
    calls,
  };
}

describe("loadShellData", () => {
  it("asks every read once with the viewer's scope, and never reads people", async () => {
    const { port, calls } = failingPort();
    const load = await loadShellData(port, query);
    expect(load.kind).toBe("ok");
    if (load.kind !== "ok") return;
    expect(load.data.org).toBe("acme");
    expect(load.data.runs).toEqual([]);
    expect(calls.people).toEqual([]);
    for (const name of METHODS) {
      if (name === "people") continue;
      expect(calls[name], name).toHaveLength(1);
      expect(calls[name][0]?.[0], name).toEqual(scope);
    }
    expect(calls.context[0]).toEqual([scope, USER_ID]);
    expect(calls.account[0]).toEqual([scope, USER_ID]);
  });

  it("is not found when the organization read is a 404 (negative)", async () => {
    const port: ShellReadPort = {
      ...failingPort().port,
      context: () => Promise.resolve(readError("org_not_found", 404)),
    };
    expect(await loadShellData(port, query)).toEqual({ kind: "not_found" });
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
