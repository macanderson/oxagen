"use client";
// Fleet's Waiting on a human tile (#3839): the pending approvals plus the
// open interjections, and a basis line that names the oldest wait. The tile
// is a button that opens the shell's approvals drawer, where both are listed.
//
// The figure comes from `waiting.ts`. A read that failed says so on the tile
// and never reads as a zero: no approvals read means no figure, and no
// interjections read leaves the figure a floor with a "+".
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { ApprovalQueue } from "@/data/contracts/approvals";
import type { InterjectionQueue } from "@/data/contracts/interjections";
import type { Read } from "@/data/read";
import { openApprovals } from "@/features/shell/client";
import { Clock } from "@/ui/clock";
import { statNote, statTerm, statTile, statValue } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { windowParts } from "./view";
import { waitingOf } from "./waiting";

export function WaitingTile({
  approvals,
  interjections,
  now,
}: {
  approvals: Read<ApprovalQueue>;
  interjections: Read<InterjectionQueue>;
  now: number;
}) {
  const t = useTranslations("fleet.stats.waiting");
  const locale = useLocale();
  const w = waitingOf(approvals, interjections);

  const windowWords = (seconds: number) => {
    const limit = windowParts(seconds);
    return limit.seconds === 0
      ? t("window", { minutes: limit.minutes })
      : t("windowSeconds", limit);
  };

  // The basis line, clause by clause, joined with a middle dot.
  const clauses: { key: string; node: ReactNode }[] = [];
  if (w.approvalsUnread !== null) {
    clauses.push({
      key: "unread",
      node: t("unread", { code: w.approvalsUnread }),
    });
  } else if (w.oldest === null) {
    // "Nothing is waiting" is a claim about both queues. With the questions
    // unread the page cannot make it, so the unread clause below stands alone.
    if (w.interjectionsUnread === null)
      clauses.push({ key: "none", node: t("none") });
  } else {
    const { since, windowSeconds, kind } = w.oldest;
    const clock = () => <Clock at={since} now={now} direction="since" />;
    clauses.push({
      key: "oldest",
      node:
        kind === "approval"
          ? t.rich("oldest", { clock, window: windowWords(windowSeconds) })
          : t.rich("oldestInterjection", {
              clock,
              window: windowWords(windowSeconds),
              count: w.interjections ?? 0,
            }),
    });
  }
  if (w.approvalsMore) clauses.push({ key: "more", node: t("moreBasis") });
  // An approval leads the line, so the questions beside it are counted here.
  // With no approval, the lead clause already names them.
  if (
    w.interjections !== null &&
    w.interjections > 0 &&
    (w.approvalsUnread !== null || w.oldest?.kind === "approval")
  )
    clauses.push({
      key: "interjections",
      node: (
        <span data-testid="waiting-interjections">
          {t("interjections", { count: w.interjections })}
        </span>
      ),
    });
  if (w.interjectionsMore)
    clauses.push({ key: "moreInterjections", node: t("moreInterjections") });
  if (w.interjectionsUnread !== null)
    clauses.push({
      key: "interjectionsUnread",
      node: (
        <span data-testid="interjections-unread">
          {t("interjectionsUnread", { code: w.interjectionsUnread })}
        </span>
      ),
    });
  if (w.count !== null) clauses.push({ key: "drawer", node: t("drawer") });

  let value: ReactNode;
  if (w.count === null) {
    value = <span className="text-muted-foreground">—</span>;
  } else {
    const count = formatCount(w.count, locale);
    value = w.floor ? t("more", { count }) : count;
  }

  return (
    <button
      type="button"
      data-testid="tile"
      aria-label={t("open")}
      onClick={openApprovals}
      className={`${statTile} cursor-pointer text-left transition-colors hover:border-rule focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
    >
      <span className={statTerm}>{t("title")}</span>
      <span className={`${statValue} text-info`}>{value}</span>
      <span className={statNote}>
        {clauses.map(({ key, node }, i) => (
          <span key={key}>
            {i > 0 ? " · " : null}
            {node}
          </span>
        ))}
      </span>
    </button>
  );
}
