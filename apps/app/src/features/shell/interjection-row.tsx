"use client";
// One open interjection in the approvals drawer (#3839): the agent that
// paused, the question it asked, the workspace, and the time left before the
// run carries on without an answer. The drawer lists these rows first, before
// the parked calls, because a paused run is stopped while a parked call is
// one step of a run that is still waiting.
//
// The row links to the run rather than answering in the drawer. A repository
// question (`repo_unknown`) is answered on that run's page, which draws the
// two paths and sends `answer_interjection` (features/run/interjection.tsx,
// #3941). A free-text question has no answer form in the app yet; it is
// answered on the API, MCP, or CLI. The row never offers an answer it cannot
// send.
import { MessageCircleQuestion } from "lucide-react";
import { useTranslations } from "next-intl";
import type { InterjectionItem } from "@/data/contracts/interjections";
import { linkText } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { routes } from "@/shared/safe-path";

/** Under two minutes left, a countdown takes the critical ink, as a parked call's does. */
const WARN_BELOW_MS = 120_000;

export function InterjectionRow({
  item,
  org,
  ws,
  wsName,
  now,
  countdown,
  agent,
}: {
  item: InterjectionItem;
  org: string;
  /** The workspace the question was raised in: its run page lives there. */
  ws: string;
  wsName: string;
  now: number;
  /** `m:ss` until an instant, or null once it has passed (the drawer's own clock). */
  countdown: (at: number, now: number) => string | null;
  /** The agent's short name, or null when the writer recorded none. */
  agent: string | null;
}) {
  const t = useTranslations("shell.approvals");
  const at = Date.parse(item.expiresAt);
  const left = countdown(at, now);
  const warn = left !== null && at - now < WARN_BELOW_MS;
  return (
    <li
      data-testid="interjection-row"
      className="flex items-start gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 text-card-foreground"
    >
      <span
        aria-hidden="true"
        className="grid size-7 flex-none place-items-center rounded-lg border border-border bg-card text-info"
      >
        <MessageCircleQuestion className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t("interjection.kind")}
        </span>
        <b className="block text-[13px] font-semibold">
          {agent === null
            ? t("interjection.pausedUnknown")
            : t("interjection.paused", { agent })}
        </b>
        <span className="block break-words text-xs">{item.question}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{wsName}</span>
          <SafeLink
            to={routes.run(org, ws, item.runId)}
            aria-label={t("interjection.openRunLabel", { run: item.runId })}
            className={linkText}
          >
            {t("interjection.openRun")}
          </SafeLink>
        </span>
      </span>
      <span
        data-countdown={item.id}
        data-warn={warn ? "" : undefined}
        className={`flex-none font-mono text-[13px] font-semibold ${
          warn ? "text-critical" : "text-info"
        }`}
      >
        {left ?? t("expired")}
      </span>
    </li>
  );
}
