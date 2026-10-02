// Review (roadmap mockups/src/work.js `reviewPanel()`, `reviewGate()`): the
// newest send's pull request, its head commit, and the required checks on
// that exact commit. A required check that failed, was cancelled or skipped,
// or has not reported holds Accept back. An optional check never does, and
// the panel says so. Results from an older head are stale evidence: a warning
// with the earlier results, never the gate.
//
// Every acceptance names the commit it was given on. Accepting merges
// nothing: the item is done once the pull request merges too, in either order.
import { useTranslations } from "next-intl";
import type { CheckConclusion, WorkItemDetail, WorkSend } from "@/data/contracts/work";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { Badge, type BadgeTone } from "@/ui/badge";
import {
  kvList,
  kvTerm,
  kvValue,
  linkText,
  note,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { PullRequestLink } from "@/ui/navigation";
import { ChecksBadge, shortSha } from "../words";
import { RefreshChecks } from "./inline-actions";
import { useWhen } from "./phrases";
import { optionalChecks, type RequiredCheck, requiredChecks } from "./view";

type At = { org: string; ws: string };

const CHECK_TONE: Record<CheckConclusion | "not_reported", BadgeTone> = {
  success: "allowed",
  failure: "failed",
  cancelled: "failed",
  skipped: "failed",
  timed_out: "failed",
  action_required: "failed",
  stale: "failed",
  neutral: "quiet",
  pending: "approval",
  not_reported: "failed",
};

function CheckRow({
  check,
  head,
  required = false,
}: {
  check: RequiredCheck;
  head: string | null;
  /** The check gates Accept, so a neutral result reads as failing. */
  required?: boolean;
}) {
  const t = useTranslations("workItem.review");
  return (
    <li
      data-testid={`work-check-${check.name}`}
      data-conclusion={check.conclusion}
      className="flex flex-wrap items-baseline gap-2 text-[13px]"
    >
      {/* A required check that ended neutral blocks Accept as a failure does. */}
      <Badge tone={check.conclusion === "neutral" && required ? "failed" : CHECK_TONE[check.conclusion]}>
        {t(`conclusions.${check.conclusion}`)}
      </Badge>
      <span className="font-mono text-[0.92em] text-foreground">{check.name}</span>
      {head === null ? null : (
        <span className="text-muted-foreground">{t("onHead", { head: shortSha(head) })}</span>
      )}
    </li>
  );
}

function Why({ send }: { send: WorkSend }) {
  const t = useTranslations("workItem.review.why");
  const head = send.pullRequest?.head ?? null;
  const at = head === null ? "" : shortSha(head);
  const failing = (requiredChecks(send) ?? []).find(
    (c) => c.conclusion !== "success" && c.conclusion !== "pending" && c.conclusion !== "not_reported",
  );
  const missing = (requiredChecks(send) ?? []).find((c) => c.conclusion === "not_reported");
  let text: string;
  switch (send.checksWord) {
    case "passing":
      text = t("passing", { head: at });
      break;
    case "failing":
      text = failing === undefined ? t("failingUnnamed", { head: at }) : t("failing", { check: failing.name, head: at });
      break;
    case "missing":
      text = missing === undefined ? t("missingUnnamed", { head: at }) : t("missing", { check: missing.name, head: at });
      break;
    case "running":
      text = t("running", { head: at });
      break;
    case "unread":
      text = t("unread", { head: at });
      break;
    case "none_required":
      text = t("none_required", { head: at });
      break;
    case "no_pull_request":
      text = t("no_pull_request");
      break;
    case "pr_closed":
      text = t("pr_closed");
      break;
  }
  return (
    <p data-testid="work-review-why" className="min-w-0 text-xs text-muted-foreground">
      {text}
    </p>
  );
}

export function ReviewPanel({
  detail,
  send,
  at,
}: {
  detail: WorkItemDetail;
  send: WorkSend;
  at: At;
}) {
  const t = useTranslations("workItem.review");
  const when = useWhen();
  const pr = send.pullRequest;
  const head = pr?.head ?? null;
  const required = requiredChecks(send);
  const optional = optionalChecks(send);
  const reviewing = detail.item.status === "in_review";
  const merged = pr?.merged ?? null;
  const closedUnmerged = pr !== null && merged === null && pr.closedAt !== null;
  const acceptedHere = send.acceptance !== null && send.acceptance.head === head;
  // Earlier results show only when there are some: a head that moved with no
  // checks read on the old one is not stale evidence.
  const earlier =
    send.earlierChecks !== null && send.earlierChecks.head !== head && send.earlierChecks.checks.length > 0
      ? send.earlierChecks
      : null;
  const staleFrom = send.staleAcceptance?.head ?? earlier?.head ?? null;
  const person = (name: string | null) => name ?? t("aPerson");
  const prUrl = pr === null ? null : parsePullRequestUrl(pr.url);

  return (
    <section
      aria-labelledby="work-review-heading"
      data-testid="work-panel-review"
      className={panel}
    >
      <div className={`${panelHeader} justify-start`}>
        <h2 id="work-review-heading" className={panelTitle}>
          {t("heading")}
        </h2>
        <span data-testid="work-review-checks">
          <ChecksBadge word={send.checksWord} />
        </span>
        <Why send={send} />
      </div>
      <div className={`${panelBody} flex flex-col gap-3.5 text-[13px]`}>
        {pr === null ? (
          <p className="text-muted-foreground">{t("noPullRequest")}</p>
        ) : (
          <>
            <dl className={kvList}>
              <dt className={kvTerm}>{t("pullRequest")}</dt>
              <dd className={`${kvValue} font-mono`}>
                {prUrl === null ? (
                  t("pullRequestRef", { repository: pr.repository, number: String(pr.number) })
                ) : (
                  <PullRequestLink to={prUrl} className={linkText}>
                    {t("pullRequestRef", { repository: pr.repository, number: String(pr.number) })}
                  </PullRequestLink>
                )}
              </dd>
              <dt className={kvTerm}>{t("head")}</dt>
              <dd className={kvValue}>
                {head === null ? (
                  <span className="text-muted-foreground">{t("headUnread")}</span>
                ) : (
                  <>
                    <code data-testid="work-review-head" className="font-mono text-[0.92em]">
                      {shortSha(head)}
                    </code>
                    {pr.headAt === null ? null : (
                      <span className="block text-xs text-muted-foreground">
                        {t("headMoved", { at: when(pr.headAt) })}
                      </span>
                    )}
                  </>
                )}
              </dd>
              <dt className={kvTerm}>{t("merge")}</dt>
              <dd className={kvValue} data-testid="work-review-merge">
                {merged !== null
                  ? t("merged", { at: when(merged.at), commit: shortSha(merged.mergeCommit) })
                  : pr.closedAt !== null
                    ? t("closedUnmerged", { at: when(pr.closedAt) })
                    : t("open")}
              </dd>
            </dl>
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-semibold text-muted-foreground">{t("required")}</p>
              {required === null ? (
                <p className="text-xs text-muted-foreground">{t("requiredUnread")}</p>
              ) : required.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("requiredNone", { head: head === null ? "" : shortSha(head) })}
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {required.map((check) => (
                    <CheckRow key={check.name} check={check} head={head} required />
                  ))}
                </ul>
              )}
            </div>
            {optional.length === 0 ? null : (
              <div className="flex flex-col gap-1.5" data-testid="work-review-optional">
                <p className="text-xs font-semibold text-muted-foreground">{t("optional")}</p>
                <p className="text-xs text-muted-foreground">{t("optionalNote")}</p>
                <ul className="flex flex-col gap-1.5">
                  {optional.map((check) => (
                    <CheckRow
                      key={check.name}
                      check={{ name: check.name, conclusion: check.conclusion }}
                      head={head}
                    />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {reviewing && send.checksWord !== "no_pull_request" ? (
          <RefreshChecks
            org={at.org}
            ws={at.ws}
            itemId={detail.item.id}
            orderId={send.id}
            canControl={detail.viewer.canControl}
          />
        ) : null}
        {staleFrom === null || head === null ? null : (
          <div
            data-testid="work-stale-evidence"
            className="flex flex-col gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5"
          >
            <p className="text-foreground">
              <span className="font-semibold">{t("staleTitle")}</span>{" "}
              {t("staleBody", { earlier: shortSha(staleFrom), head: shortSha(head) })}
            </p>
            {earlier === null ? null : (
              <>
                <p className="text-xs font-semibold text-muted-foreground">{t("earlier")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("earlierNote", { head: shortSha(earlier.head) })}
                </p>
                <ul className="flex flex-col gap-1.5">
                  {earlier.checks.map((check) => (
                    <CheckRow
                      key={check.name}
                      check={{ name: check.name, conclusion: check.conclusion }}
                      head={earlier.head}
                    />
                  ))}
                </ul>
              </>
            )}
            {send.staleAcceptance === null ? null : (
              <p className="text-xs text-muted-foreground">
                {t("staleAcceptance", {
                  by: person(send.staleAcceptance.by),
                  head: shortSha(send.staleAcceptance.head),
                  at: when(send.staleAcceptance.at),
                })}
              </p>
            )}
          </div>
        )}
        {merged !== null && send.acceptance === null && reviewing ? (
          <p
            data-testid="work-merged-before-review"
            className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-foreground"
          >
            <span className="font-semibold">{t("mergedFirstTitle")}</span>{" "}
            {t("mergedFirstBody", { at: when(merged.at) })}
          </p>
        ) : null}
        {closedUnmerged ? (
          <p
            data-testid="work-closed-unmerged"
            className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-foreground"
          >
            <span className="font-semibold">{t("closedTitle")}</span> {t("closedBody")}
          </p>
        ) : null}
        {send.acceptance === null ? null : (
          <p data-testid="work-acceptance" className={note}>
            {t("acceptance", {
              by: person(send.acceptance.by),
              head: shortSha(send.acceptance.head),
              at: when(send.acceptance.at),
            })}
          </p>
        )}
        {reviewing && pr !== null && head !== null && !closedUnmerged && !acceptedHere ? (
          <p data-testid="work-review-consequence" className="text-xs text-muted-foreground">
            {t("consequence", { head: shortSha(head) })}
          </p>
        ) : null}
      </div>
    </section>
  );
}
