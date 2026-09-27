// What the Waiting on a human tile adds up (#3839): the pending approvals and
// the open interjections, each from its own read, and the oldest wait its
// basis line names. Pure, so the tile draws what this returns and a test can
// hold the figure without rendering.
//
// The figure is approvals plus interjections, as the design counts it. The
// basis line names the oldest approval when one waits, and the interjections
// beside it. With no approval waiting it names the oldest interjection
// instead. A read that failed never counts as a zero: the approvals read
// decides whether there is a figure at all, and an interjections read that
// failed leaves the figure a floor and says so.
import type { ApprovalQueue } from "@/data/contracts/approvals";
import type {
  InterjectionItem,
  InterjectionQueue,
} from "@/data/contracts/interjections";
import type { Read } from "@/data/read";
import { oldestApproval } from "./view";

/** The wait the basis line names, with the window it runs against. */
type OldestWait = {
  kind: "approval" | "interjection";
  /** Epoch milliseconds the wait began. */
  since: number;
  /** The whole window from raise to expiry, in seconds. */
  windowSeconds: number;
};

type Waiting = {
  /** Approvals plus open interjections, or null when the approvals were not read. */
  count: number | null;
  /** True when the figure is a floor: a queue ran past its read, or the interjections were not read. */
  floor: boolean;
  /** Open interjections read; null when that read failed. */
  interjections: number | null;
  /** The approvals queue ran past the read. */
  approvalsMore: boolean;
  /** The interjections queue ran past the read. */
  interjectionsMore: boolean;
  /** Why the approvals were not read; null when they were. */
  approvalsUnread: string | null;
  /** Why the interjections were not read; null when they were. */
  interjectionsUnread: string | null;
  /** The oldest approval, else the oldest interjection; null when nothing waits or nothing was read. */
  oldest: OldestWait | null;
};

/**
 * The code a failed read names: the permission a refusal needed, the error
 * code, or the access request.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function unreadCode<T>(read: Read<T>): string | null {
  if (read.ok) return null;
  switch (read.reason) {
    case "denied":
      return read.permission;
    case "error":
      return read.code;
    case "pending_approval":
      return read.accessRequestId;
  }
}

/**
 * The interjection that has waited longest, and its window from raise to
 * expiry.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function oldestInterjection(
  items: readonly InterjectionItem[],
): { since: number; windowSeconds: number } | null {
  let oldest: InterjectionItem | null = null;
  for (const item of items)
    if (
      oldest === null ||
      Date.parse(item.raisedAt) < Date.parse(oldest.raisedAt)
    )
      oldest = item;
  if (oldest === null) return null;
  const since = Date.parse(oldest.raisedAt);
  return {
    since,
    windowSeconds: Math.max(0, (Date.parse(oldest.expiresAt) - since) / 1000),
  };
}

export function waitingOf(
  approvals: Read<ApprovalQueue>,
  interjections: Read<InterjectionQueue>,
): Waiting {
  const questions = interjections.ok ? interjections.value.items : [];
  const interjectionCount = interjections.ok ? questions.length : null;
  const interjectionsMore = interjections.ok && interjections.value.more;
  const base = {
    interjections: interjectionCount,
    interjectionsMore,
    interjectionsUnread: unreadCode(interjections),
  };
  if (!approvals.ok) {
    return {
      ...base,
      count: null,
      floor: false,
      approvalsMore: false,
      approvalsUnread: unreadCode(approvals),
      oldest: null,
    };
  }
  const { items, more } = approvals.value;
  const approval = oldestApproval(items);
  const question = oldestInterjection(questions);
  const oldest: OldestWait | null =
    approval !== null
      ? {
          kind: "approval",
          since: approval.createdAt,
          windowSeconds: approval.windowSeconds,
        }
      : question !== null
        ? { kind: "interjection", ...question }
        : null;
  return {
    ...base,
    count: items.length + (interjectionCount ?? 0),
    floor: more || interjectionsMore || !interjections.ok,
    approvalsMore: more,
    approvalsUnread: null,
    oldest,
  };
}
