"use client";
// The counts the chrome draws, each read off a record and none typed twice
// (mockups/pages/audit-prompt.md check 5): the topbar's approvals badge over
// the whole organization, and the sidebar's Fleet, Steering and Audit counts
// for the workspace the sidebar points at. A count is null until its read
// lands and draws nothing then; a read that failed, or answered null, is
// listed in `unrecorded` so the sidebar says so rather than drawing a zero or
// nothing at all. The topbar badge and the Fleet count each add the open
// interjections to the pending approvals (#3839), from the same reads the
// drawer lists, so the count and the list never disagree.
import type { NotificationFeed } from "@/data/contracts/shell";
import type { Read } from "@/data/read";
import { useWorkspaceActivity } from "./activity-store";
import type { ShellData } from "./shell-data";
import { useSidebarSections } from "./sidebar-sections";

export type OrgWaiting = {
  /** Pending approvals plus open interjections across every workspace read. */
  count: number;
  /** True when a workspace or its questions were not read, or a queue ran past the read: the badge says "+". */
  partial: boolean;
};

/** Open questions in one workspace's read, or 0 when the read failed (the caller marks that partial). */
function openQuestions(w: ShellData["approvals"]["workspaces"][number]) {
  return w.interjections.ok ? w.interjections.value.items.length : 0;
}

/** True when a workspace's questions were not read or ran past the read. */
function questionsShort(w: ShellData["approvals"]["workspaces"][number]) {
  return !w.interjections.ok || w.interjections.value.more;
}

/** The three nav items that carry a count (audit-prompt check 5). */
type NavCountKey = "fleet" | "steering" | "audit";

export type ShellCounts = {
  /** The topbar button's figure; null when no workspace's queue could be read. */
  waiting: OrgWaiting | null;
  fleet: number | null;
  /** True when this workspace's queue ran past the read: the Fleet count says "+", as the drawer's header does. */
  fleetMore: boolean;
  steering: number | null;
  audit: number | null;
  /** The counts whose read landed without a figure: drawn as "not recorded", never as zero. */
  unrecorded: readonly NavCountKey[];
  /** The bell's feed: the open workspace's, or the organization's first on an organization page. */
  feed: Read<NotificationFeed> | null;
};

export function orgWaiting(data: ShellData): OrgWaiting | null {
  const read = data.approvals.workspaces.flatMap((w) =>
    w.pending.ok ? [{ queue: w.pending.value, w }] : [],
  );
  if (read.length === 0) return null;
  return {
    count: read.reduce(
      (n, { queue, w }) => n + queue.items.length + openQuestions(w),
      0,
    ),
    partial:
      data.approvals.truncated ||
      read.length < data.approvals.workspaces.length ||
      read.some(({ queue, w }) => queue.more || questionsShort(w)),
  };
}

export function useShellCounts(data: ShellData): ShellCounts {
  const { ws } = useSidebarSections(data);
  const activity = useWorkspaceActivity(ws);
  const here = data.approvals.workspaces.find((w) => w.slug === ws);
  // A workspace page publishes its own read; an organization page has none,
  // so the chrome's own read of the first workspace (the one the sidebar
  // points at there) stands in. A read for another workspace is never used.
  const read =
    activity?.counts ??
    (data.counts !== null && data.counts.slug === ws ? data.counts.read : null);
  const counts = read?.ok ? read.value : null;
  const steering = counts?.proposals ?? null;
  const audit = counts?.incidents ?? null;
  // Once a read is here it has landed; before that a null is a count on its
  // way, not a count that is missing.
  const unrecorded: NavCountKey[] = [];
  if (here !== undefined && !here.pending.ok) unrecorded.push("fleet");
  if (read !== null && steering === null) unrecorded.push("steering");
  if (read !== null && audit === null) unrecorded.push("audit");
  return {
    waiting: orgWaiting(data),
    // The same sum as the badge, for this workspace: parked calls plus open
    // questions. The phone's Fleet slot reads it too.
    fleet: here?.pending.ok
      ? here.pending.value.items.length + openQuestions(here)
      : null,
    fleetMore:
      here?.pending.ok === true &&
      (here.pending.value.more || questionsShort(here)),
    steering,
    audit,
    unrecorded,
    feed: activity?.feed ?? data.feed,
  };
}
