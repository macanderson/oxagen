// The words every Work surface draws an item with (roadmap mockups/src/work.js
// `stateBadge()`, `waitLine()`, `prioCell()`, `costCell()`, and the
// required-checks word of `reviewGate()`): the status beside its dot, the one
// line that says what the item waits for, the priority with its reason and
// the rules it cites, the required-checks word, and what the runs cost with
// the share Oxagen knows.
//
// The server decides each status and wait (list_work_items,
// get_work_item); these components only name them. A state word always sits
// beside its dot, so the state survives greyscale. Gold never carries state,
// and no Phase 1 word claims a verdict: there is no Held and no Proven here.
import { useTranslations } from "next-intl";
import type {
  ChecksWord,
  CostCoverage,
  ForgePullRequest,
  WorkPriority,
  WorkStatus,
  WorkWait,
} from "@/data/contracts/work";
import { Badge, type BadgeTone } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";

/** The first seven characters of a commit, as a reviewer reads it. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

const STATUS_TONE: Record<WorkStatus, BadgeTone> = {
  triaging: "quiet",
  triage_failed: "failed",
  needs_info: "approval",
  possible_duplicate: "approval",
  out_of_scope: "quiet",
  brief_to_approve: "approval",
  changed: "approval",
  ready: "allowed",
  send_rejected: "failed",
  waiting_for_claim: "quiet",
  no_answer: "failed",
  running: "allowed",
  stopping: "approval",
  in_review: "approval",
  accepted: "allowed",
  done: "allowed",
  closed: "quiet",
};

/** A status that is happening now breathes. */
const LIVE: ReadonlySet<WorkStatus> = new Set(["triaging", "running"]);

/** The item's status as a word beside its dot. */
export function WorkStatusBadge({ status }: { status: WorkStatus }) {
  const t = useTranslations("work.status");
  return (
    <Badge tone={STATUS_TONE[status]} dot={LIVE.has(status) ? "pulse" : true} data-status={status}>
      {t(status)}
    </Badge>
  );
}

const CHECKS_TONE: Record<ChecksWord, BadgeTone> = {
  passing: "allowed",
  failing: "failed",
  missing: "failed",
  running: "approval",
  unread: "approval",
  none_required: "approval",
  no_pull_request: "failed",
  pr_closed: "failed",
};

const PULL_TONE: Record<ForgePullRequest["state"], BadgeTone> = {
  open: "approval",
  draft: "quiet",
  merged: "allowed",
  closed: "quiet",
};

/** A pull request's state as the forge store last recorded it, as one word. */
export function PullStateBadge({ pull }: { pull: ForgePullRequest }) {
  const t = useTranslations("work.pullState");
  const format = useFormatter();
  return (
    <Badge
      tone={PULL_TONE[pull.state]}
      data-pull-state={pull.state}
      title={t("seen", {
        at: format.dateTime(new Date(pull.stateSeenAt), { dateStyle: "medium", timeStyle: "short" }),
      })}
    >
      {t(pull.state)}
    </Badge>
  );
}

/** The required checks on the head commit, as one word beside its dot. */
export function ChecksBadge({ word }: { word: ChecksWord }) {
  const t = useTranslations("work.checks");
  return (
    <Badge tone={CHECKS_TONE[word]} data-checks={word}>
      {t(word)}
    </Badge>
  );
}

const PRIORITY_TONE: Record<NonNullable<WorkPriority["label"]>, BadgeTone> = {
  P0: "critical",
  P1: "denied",
  P2: "approval",
  P3: "quiet",
};

/**
 * The priority: the badge, then who set it, triage's reason, and the rules it
 * cites. A triage priority always shows its reason. An item with no priority
 * reads none.
 */
export function PriorityCell({ priority }: { priority: WorkPriority }) {
  const t = useTranslations("work.priority");
  if (priority.label === null) {
    return <span className="text-muted-foreground">{t("none")}</span>;
  }
  return (
    <span className="flex min-w-0 flex-col items-start gap-1" data-priority={priority.label}>
      <Badge tone={PRIORITY_TONE[priority.label]} dot={false}>
        {priority.label}
      </Badge>
      <span className="text-xs text-muted-foreground" data-wrap="">
        {priority.by === "person" && priority.setBy !== null ? `${t("setBy", { name: priority.setBy })} ` : null}
        {priority.reason}
        {priority.cites.map((cite) => (
          <span key={cite} className={`${mono} ml-1 text-dim`}>
            {cite}
          </span>
        ))}
      </span>
    </span>
  );
}

/** What an item's runs cost: the known total and its coverage, or none yet. An unknown cost never reads $0.00. */
export function CostText({ cost }: { cost: CostCoverage }) {
  const t = useTranslations("work.cost");
  if (cost.runs === 0) return <span className="text-muted-foreground">{t("none")}</span>;
  return (
    <span className="inline-flex flex-col items-end gap-0.5" data-cost-known={cost.knownRuns} data-cost-runs={cost.runs}>
      {cost.total === null ? <span className="text-muted-foreground">{t("unknown")}</span> : <Money value={cost.total} />}
      {cost.knownRuns < cost.runs ? (
        <span className="text-xs text-muted-foreground">
          {t("coverage", { known: cost.knownRuns, runs: cost.runs })}
        </span>
      ) : null}
    </span>
  );
}

/** One line that says what the item waits for. */
export function WaitLine({ wait }: { wait: WorkWait }) {
  const t = useTranslations("work.wait");
  const format = useFormatter();
  const when = (at: string) =>
    format.dateTime(new Date(at), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const who = (by: string | null) => by ?? t("aPerson");
  const runtime = (name: string | null) => name ?? t("theRuntime");
  const poll = (at: string | null) => (at === null ? t("neverPolled") : t("lastPoll", { at: when(at) }));
  let text: string;
  switch (wait.kind) {
    case "triaging":
      text = t("triaging");
      break;
    case "triage_failed":
      text = t("triage_failed", { reason: wait.reason });
      break;
    case "needs_info":
      text = wait.question === null ? t("needs_infoNoQuestion") : t("needs_info", { question: wait.question });
      break;
    case "possible_duplicate":
      text = wait.of === null ? t("possible_duplicateUnknown") : t("possible_duplicate", { number: wait.of.number });
      break;
    case "out_of_scope":
      text = t("out_of_scope");
      break;
    case "brief_to_approve":
      text =
        wait.reopened !== null
          ? t("brief_to_approveReopened", {
              by: who(wait.reopened.by),
              at: when(wait.reopened.at),
              reason: wait.reopened.reason,
            })
          : wait.fromTriage
            ? t("brief_to_approveTriage")
            : t("brief_to_approve");
      break;
    case "brief_to_write":
      text = t("brief_to_write");
      break;
    case "changed":
      text =
        wait.cause === "brief"
          ? t("changedBrief")
          : wait.at === null || wait.approvedRevision === null
            ? t("changedSourceNoTime")
            : t("changedSource", { at: when(wait.at), revision: wait.approvedRevision });
      break;
    case "ready":
      text =
        wait.lastSend === null
          ? t("ready")
          : wait.lastSend.delivery === "withdrawn"
            ? t("readyWithdrawn")
            : wait.lastSend.delivery === "stopped"
              ? t("readyStopped")
              : t("readyReturned", { reason: wait.lastSend.reason ?? "" });
      break;
    case "send_rejected":
      text = t("send_rejected", { reason: wait.reason });
      break;
    case "waiting_for_claim":
      text = `${t("waiting_for_claim", { runtime: runtime(wait.runtime), sent: when(wait.sentAt) })} ${poll(wait.lastPollAt)}`;
      break;
    case "no_answer":
      text = `${t("no_answer", { runtime: runtime(wait.runtime) })} ${poll(wait.lastPollAt)}`;
      break;
    case "running":
      text = wait.changedSinceSend
        ? t("runningChanged", { revision: wait.briefRevision })
        : t("running", { revision: wait.briefRevision });
      break;
    case "stopping":
      text = t("stopping", { runtime: runtime(wait.runtime) });
      break;
    case "ready_for_review":
      text = t("ready_for_review", { head: shortSha(wait.head) });
      break;
    case "no_required_checks":
      text = t("no_required_checks", { head: shortSha(wait.head) });
      break;
    case "check_failed":
      text = t("check_failed", { check: wait.check, conclusion: wait.conclusion, head: shortSha(wait.head) });
      break;
    case "check_missing":
      text = t("check_missing", { check: wait.check, head: shortSha(wait.head) });
      break;
    case "checks_running":
      text = t("checks_running", { head: shortSha(wait.head) });
      break;
    case "checks_unread":
      text = t("checks_unread", { head: shortSha(wait.head) });
      break;
    case "new_head":
      text = t("new_head", { head: shortSha(wait.head), earlier: shortSha(wait.earlier) });
      break;
    case "no_pull_request":
      text = t("no_pull_request");
      break;
    case "no_head":
      text = t("no_head");
      break;
    case "pr_closed":
      text = t("pr_closed");
      break;
    case "merged_before_review":
      text = t("merged_before_review", { at: when(wait.at) });
      break;
    case "merged_by_app":
      text = t("merged_by_app", { login: wait.login, at: when(wait.at) });
      break;
    case "brief_out_of_date":
      text = t("brief_out_of_date");
      break;
    case "accepted_waiting_merge":
      text = t("accepted_waiting_merge", { by: who(wait.by), head: shortSha(wait.head) });
      break;
    case "done":
      text = t("done", {
        by: who(wait.accepted.by),
        head: shortSha(wait.accepted.head),
        accepted: when(wait.accepted.at),
        merged: when(wait.mergedAt),
      });
      break;
    case "closed":
      text = t("closed", { resolution: wait.resolution, by: who(wait.by), at: when(wait.at), reason: wait.reason });
      break;
  }
  return (
    // The line says what the item waits for, so it wraps in a table cell
    // rather than end in an ellipsis (globals.css, data-wrap, #4674).
    <span className="text-sm text-muted-foreground" data-wait={wait.kind} data-wrap="">
      {text}
    </span>
  );
}
