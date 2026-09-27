// The workspace layer's reads: the nav counts and the feed for the workspace
// the layout resolved, handed to the chrome as they were read, a refusal
// included.
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import type { WorkspaceActivity } from "./activity-store";
import { ShellWorkspace } from "./workspace-activity";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

describe("ShellWorkspace", () => {
  it("reads the workspace's counts and feed and publishes them under its slug", async () => {
    const counts = readOk({
      approvals: 2,
      interjections: null,
      proposals: null,
      incidents: null,
    });
    const feed = readError("control_plane_unavailable", 503);
    const source = {
      shell: {
        context: vi.fn(),
        preferences: vi.fn(),
        counts: vi.fn(() => Promise.resolve(counts)),
        notifications: vi.fn(() => Promise.resolve(feed)),
        assistantEngine: vi.fn(),
      },
    };
    const { WsCtx } = await import("@/server/viewer");
    const { unsafeMint } = await import("@/server/viewer.testing");
    const ctx = unsafeMint(WsCtx, {
      userId: "usr_marcusbell",
      orgId: "7a000000-0000-4000-8000-0000000000a1",
      orgSlug: "acme",
      orgName: "Acme Robotics",
      orgRole: "member",
      workspaceId: "7a000000-0000-4000-8000-0000000000b1",
      wsSlug: "core-platform",
      wsName: "Core platform",
      wsRole: "member",
    });
    const element: ReactElement<{ activity: WorkspaceActivity }> =
      await ShellWorkspace({ ctx, source });
    expect(isValidElement(element)).toBe(true);
    expect(element.props.activity).toEqual({
      slug: "core-platform",
      counts,
      feed,
    });
    expect(source.shell.counts).toHaveBeenCalledWith(ctx);
    expect(source.shell.notifications).toHaveBeenCalledWith(ctx);
  });
});
