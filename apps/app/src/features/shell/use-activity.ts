"use client";
// The counts the chrome draws, each read off a record and none typed twice
// (mockups/pages/audit-prompt.md check 5): the topbar's approvals badge over
// the whole organization, and the sidebar's Fleet, Steering and Audit counts
// for the workspace the sidebar points at. A count is null until its read
// lands and draws nothing then; a read that failed, or answered null, is
// listed in `unrecorded` so the sidebar says so rather than drawing a zero or
// nothing at all. No interjection is recorded (#3849), so none is counted.
import type { NotificationFeed } from "@/data/contracts/shell";
import type { Read } from "@/data/read";
import { useWorkspaceActivity } from "./activity-store";
import type { ShellData } from "./shell-data";
import { useSidebarSections } from "./sidebar-sections";

export type OrgWaiting = {
  /** Pending approvals across every workspace read. An open interjection would add here; none is recorded yet. */
  count: number;
  /** True when a workspace was not read, or its queue ran past the read: the badge says "+". */
  partial: boolean;
};

/** The three nav items that carry a count (audit-prompt check 5). */
export type NavCountKey = "fleet" | "steering" | "audit";

export type ShellCounts = {
  /** The topbar button's figure; null when no workspace's queue could be read. */
  waiting: OrgWaiting | null;
  fleet: number | null;
  steering: number | null;
  audit: number | null;
  /** The counts whose read landed without a figure: drawn as "not recorded", never as zero. */
  unrecorded: readonly NavCountKey[];
  /** The bell's feed: the open workspace's, or the organization's first on an organization page. */
  feed: Read<NotificationFeed> | null;
};

export function orgWaiting(data: ShellData): OrgWaiting | null {
  const read = data.approvals.workspaces.flatMap((w) =>
    w.pending.ok ? [w.pending.value] : [],
  );
  if (read.length === 0) return null;
  return {
    count: read.reduce((n, queue) => n + queue.items.length, 0),
    partial:
      data.approvals.truncated ||
      read.length < data.approvals.workspaces.length ||
      read.some((queue) => queue.more),
  };
}

export function useShellCounts(data: ShellData): ShellCounts {
  const { ws } = useSidebarSections(data);
  const activity = useWorkspaceActivity(ws);
  const here = data.approvals.workspaces.find((w) => w.slug === ws);
  const counts = activity?.counts.ok ? activity.counts.value : null;
  const steering = counts?.proposals ?? null;
  const audit = counts?.incidents ?? null;
  // The workspace's read has landed once `activity` is here; before that a
  // null is a count on its way, not a count that is missing.
  const unrecorded: NavCountKey[] = [];
  if (here !== undefined && !here.pending.ok) unrecorded.push("fleet");
  if (activity !== null && steering === null) unrecorded.push("steering");
  if (activity !== null && audit === null) unrecorded.push("audit");
  return {
    waiting: orgWaiting(data),
    fleet: here?.pending.ok ? here.pending.value.items.length : null,
    steering,
    audit,
    unrecorded,
    feed: activity?.feed ?? data.feed,
  };
}
