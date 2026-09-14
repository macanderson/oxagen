import { describe, expect, it, vi } from "vitest";
import { liveShell } from "@/data/adapters/live/shell";
import { notBacked, readError } from "@/data/not-backed";
import type { ShellReadPort } from "@/data/ports";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { loadShellData } from "./load";
import { shellData } from "./shell.builders";

const USER_ID = "usr_marcusbell";
const scope = {
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};
const query = { org: "acme", scope, userId: USER_ID };

describe("loadShellData", () => {
  it("asks the context read once, as the viewer, and hands it to the shell", async () => {
    const { context } = shellData();
    const read = vi.fn(() => Promise.resolve(context));
    const port: ShellReadPort = { context: read };
    expect(await loadShellData(port, query)).toEqual({
      kind: "ok",
      data: { org: "acme", context },
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(scope, USER_ID);
  });

  it("reads nothing but the context: the port has no other method to call (negative)", () => {
    // The rev1 shell has one read (ARCHITECTURE.md §3.3). A port carrying any
    // other method is a type error at the call site, so a value assertion is
    // what remains: the live adapter's surface is exactly `context`.
    expect(Object.keys(liveShell)).toEqual(["context"]);
  });

  it("is not found when the organization read is a 404 (negative)", async () => {
    const port: ShellReadPort = {
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

    const erroredContext: ShellReadPort = {
      context: () =>
        Promise.resolve(readError("control_plane_unavailable", 503)),
    };
    expect((await loadShellData(erroredContext, query)).kind).toBe("ok");
    const notBackedContext: ShellReadPort = {
      context: () => Promise.resolve(notBacked("M1", "G15")),
    };
    expect((await loadShellData(notBackedContext, query)).kind).toBe("ok");
  });
});
