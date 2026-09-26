// @vitest-environment jsdom
// The chrome's counts, read off the records and never typed twice: the topbar's
// organization-wide approvals figure (`orgWaiting`) and the sidebar's Fleet,
// Steering and Audit counts for the workspace the sidebar points at
// (`useShellCounts`). A count whose read landed without a figure is listed as
// unrecorded; a count still on its way is null and listed nowhere.
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { WorkspaceActivitySync } from "./activity-store";
import {
  approvalItem,
  interjectionItem,
  shellData,
  shellWorkspace,
} from "./shell.builders";
import type { WorkspaceApprovals } from "./shell-data";
import { orgWaiting, useShellCounts } from "./use-activity";

const nav = vi.hoisted(() => ({ pathname: "/acme/core-platform" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

beforeEach(() => {
  nav.pathname = "/acme/core-platform";
});

afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

const denied = {
  ok: false as const,
  reason: "denied" as const,
  permission: "workspace.read",
};

describe("orgWaiting", () => {
  it("sums every read queue and is whole when every workspace was read to its end", () => {
    const data = shellData({
      approvals: {
        workspaces: [
          shellWorkspace({
            pending: readOk({ items: [approvalItem()], more: false }),
          }),
          shellWorkspace({
            slug: "finops",
            pending: readOk({
              items: [
                approvalItem({ id: "apr_02K5RS8F3J" }),
                approvalItem({ id: "apr_03K5RS8F3J" }),
              ],
              more: false,
            }),
          }),
        ],
        truncated: false,
        readAt: 0,
      },
    });
    expect(orgWaiting(data)).toEqual({ count: 3, partial: false });
  });

  it("answers null, not zero, when no workspace's queue could be read (negative)", () => {
    const data = shellData({
      approvals: {
        workspaces: [shellWorkspace({ pending: denied })],
        truncated: false,
        readAt: 0,
      },
    });
    expect(orgWaiting(data)).toBeNull();
  });

  it("answers null when the organization has no workspace to read (negative)", () => {
    const data = shellData({
      approvals: { workspaces: [], truncated: false, readAt: 0 },
    });
    expect(orgWaiting(data)).toBeNull();
  });

  it.each([
    [
      "the organization has more workspaces than the chrome read",
      { truncated: true, pending: readOk({ items: [], more: false }) },
    ],
    [
      "a queue ran past the read",
      { truncated: false, pending: readOk({ items: [], more: true }) },
    ],
  ])("is partial when %s", (_why, { truncated, pending }) => {
    const data = shellData({
      approvals: {
        workspaces: [shellWorkspace({ pending })],
        truncated,
        readAt: 0,
      },
    });
    expect(orgWaiting(data)).toEqual({ count: 0, partial: true });
  });

  it("is partial when one workspace's queue could not be read, and counts only the ones that were", () => {
    const data = shellData({
      approvals: {
        workspaces: [
          shellWorkspace({ pending: readError("run_index_unavailable", 503) }),
          shellWorkspace({
            slug: "finops",
            pending: readOk({ items: [approvalItem()], more: false }),
          }),
        ],
        truncated: false,
        readAt: 0,
      },
    });
    expect(orgWaiting(data)).toEqual({ count: 1, partial: true });
  });

  // #3839: the badge counted parked calls only while an agent could sit
  // paused on a question the drawer never listed.
  it("adds each workspace's open interjections to its parked calls", () => {
    const data = shellData({
      approvals: {
        workspaces: [
          shellWorkspace({
            pending: readOk({ items: [approvalItem()], more: false }),
            interjections: readOk({
              items: [interjectionItem()],
              more: false,
            }),
          }),
          shellWorkspace({
            slug: "finops",
            interjections: readOk({
              items: [interjectionItem({ id: "inj_02K5RSA4TW" })],
              more: false,
            }),
          }),
        ],
        truncated: false,
        readAt: 0,
      },
    });
    expect(orgWaiting(data)).toEqual({ count: 3, partial: false });
  });

  it("is partial when a workspace's questions were not read or ran past the read (negative)", () => {
    const one = (interjections: WorkspaceApprovals["interjections"]) =>
      orgWaiting(
        shellData({
          approvals: {
            workspaces: [
              shellWorkspace({
                pending: readOk({ items: [approvalItem()], more: false }),
                interjections,
              }),
            ],
            truncated: false,
            readAt: 0,
          },
        }),
      );
    expect(one(readError("record_unmappable", 502))).toEqual({
      count: 1,
      partial: true,
    });
    expect(one(readOk({ items: [interjectionItem()], more: true }))).toEqual({
      count: 2,
      partial: true,
    });
  });
});

describe("useShellCounts", () => {
  it("adds this workspace's open interjections to the Fleet count, and marks it + when they were not all read", () => {
    const withQuestion = shellData({
      approvals: {
        workspaces: [
          shellWorkspace({
            pending: readOk({ items: [approvalItem()], more: false }),
            interjections: readOk({
              items: [interjectionItem()],
              more: false,
            }),
          }),
        ],
        truncated: false,
        readAt: 0,
      },
    });
    const { result } = renderHook(() => useShellCounts(withQuestion));
    expect(result.current.fleet).toBe(2);
    expect(result.current.fleetMore).toBe(false);
    const unread = shellData({
      approvals: {
        workspaces: [shellWorkspace({ interjections: readError("down", 503) })],
        truncated: false,
        readAt: 0,
      },
    });
    const second = renderHook(() => useShellCounts(unread));
    expect(second.result.current.fleet).toBe(0);
    expect(second.result.current.fleetMore).toBe(true);
  });

  it("counts Fleet from this workspace's queue, with its + when the queue ran past the read", () => {
    const data = shellData({
      approvals: {
        workspaces: [
          shellWorkspace({
            pending: readOk({ items: [approvalItem()], more: true }),
          }),
          shellWorkspace({
            slug: "finops",
            pending: readOk({
              items: [approvalItem({ id: "apr_02K5RS8F3J" })],
              more: false,
            }),
          }),
        ],
        truncated: false,
        readAt: 0,
      },
    });
    const { result } = renderHook(() => useShellCounts(data));
    expect(result.current.fleet).toBe(1);
    expect(result.current.fleetMore).toBe(true);
    expect(result.current.waiting).toEqual({ count: 2, partial: true });
    expect(result.current.unrecorded).toEqual([]);
  });

  it("lists Fleet as unrecorded when this workspace's queue could not be read, never zero (negative)", () => {
    const data = shellData({
      approvals: {
        workspaces: [shellWorkspace({ pending: denied })],
        truncated: false,
        readAt: 0,
      },
    });
    const { result } = renderHook(() => useShellCounts(data));
    expect(result.current.fleet).toBeNull();
    expect(result.current.fleetMore).toBe(false);
    expect(result.current.unrecorded).toEqual(["fleet"]);
  });

  it("claims nothing about Fleet for a workspace the drawer did not read (negative)", () => {
    nav.pathname = "/acme/unlisted";
    const { result } = renderHook(() => useShellCounts(shellData()));
    expect(result.current.fleet).toBeNull();
    expect(result.current.unrecorded).not.toContain("fleet");
  });

  it("treats Steering and Audit as on their way, not unrecorded, until a read lands", () => {
    const { result } = renderHook(() =>
      useShellCounts(shellData({ counts: null })),
    );
    expect(result.current.steering).toBeNull();
    expect(result.current.audit).toBeNull();
    expect(result.current.unrecorded).toEqual([]);
  });

  it("reads Steering and Audit from the chrome's read of the sidebar's workspace on an organization page", () => {
    nav.pathname = "/acme/billing";
    const { result } = renderHook(() =>
      useShellCounts(
        shellData({
          counts: {
            slug: "core-platform",
            read: readOk({
              approvals: 0,
              interjections: null,
              proposals: 5,
              incidents: 0,
            }),
          },
        }),
      ),
    );
    expect(result.current.steering).toBe(5);
    expect(result.current.audit).toBe(0);
    expect(result.current.unrecorded).toEqual([]);
  });

  it("lists Steering and Audit as unrecorded when the read landed without them (negative)", () => {
    const { result } = renderHook(() =>
      useShellCounts(
        shellData({
          counts: {
            slug: "core-platform",
            read: readError("control_plane_unavailable", 503),
          },
        }),
      ),
    );
    expect(result.current.steering).toBeNull();
    expect(result.current.unrecorded).toEqual(["steering", "audit"]);
  });

  it("ignores the chrome's read when it was made for another workspace (negative)", () => {
    const { result } = renderHook(() =>
      useShellCounts(
        shellData({
          counts: {
            slug: "finops",
            read: readOk({
              approvals: 0,
              interjections: null,
              proposals: 5,
              incidents: 2,
            }),
          },
        }),
      ),
    );
    expect(result.current.steering).toBeNull();
    expect(result.current.audit).toBeNull();
    expect(result.current.unrecorded).toEqual([]);
  });

  it("prefers the open workspace's published counts and feed over the chrome's own", () => {
    const orgFeed = readOk({ items: [], unread: 1 });
    const wsFeed = readOk({ items: [], unread: 9 });
    const data = shellData({
      feed: orgFeed,
      counts: {
        slug: "core-platform",
        read: readOk({
          approvals: 0,
          interjections: null,
          proposals: 1,
          incidents: 1,
        }),
      },
    });
    const { result } = renderHook(() => useShellCounts(data));
    expect(result.current.feed).toBe(orgFeed);
    act(() => {
      render(
        <WorkspaceActivitySync
          activity={{
            slug: "core-platform",
            counts: readOk({
              approvals: 0,
              interjections: null,
              proposals: 4,
              incidents: 2,
            }),
            feed: wsFeed,
          }}
        />,
      );
    });
    expect(result.current.feed).toBe(wsFeed);
    expect(result.current.steering).toBe(4);
    expect(result.current.audit).toBe(2);
  });
});
