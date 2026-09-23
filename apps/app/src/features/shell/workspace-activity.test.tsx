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
    const counts = readOk({ approvals: 2, proposals: null, incidents: null });
    const feed = readError("control_plane_unavailable", 503);
    const source = {
      shell: {
        context: vi.fn(),
        preferences: vi.fn(),
        counts: vi.fn(() => Promise.resolve(counts)),
        notifications: vi.fn(() => Promise.resolve(feed)),
      },
    };
    const ctx = { wsSlug: "core-platform" } as never;
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
