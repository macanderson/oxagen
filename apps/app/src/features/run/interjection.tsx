// The Run page for a run whose host stopped the loop on a repository question
// (#3941, spec pages/run-interjection.md): the same route as an ordinary run,
// drawn as three panes. What the agent shows its operator, what Oxagen put to
// a person, and what the recording holds.
//
// A run is drawn this way when its recording carries a `control.interject`
// frame on the run's own chain and the URL names no tab; any tab, the
// transcript link in the Answer section among them, opens the ordinary page.
// The header and the frames come from `get_run`. The question, its two paths,
// its window and its answer come from `list_interjections` for this run
// (`interjections.forRun`), because the host sealed them in the question's
// body and the control plane recorded the answer and its receipt on the row.
// A fact neither read holds is left out, not guessed: a frame that has not
// happened is drawn greyed, with no time.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  InterjectionItem,
  InterjectionQueue,
} from "@/data/contracts/interjections";
import type { RunDetail, RunFrame } from "@/data/contracts/run";
import type { Read } from "@/data/read";
import type { OrgRole, WsRole } from "@/server/viewer";
import { canAnswerRepositoryQuestion } from "@/shared/run-command-roles";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  eyebrow,
  kvList,
  kvTerm,
  kvValue,
  linkText,
  mono,
  panel,
} from "@/ui/control-styles";
import { formatDuration } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { StatusBadge } from "@/ui/status-badge";
import { InterjectionAnswer } from "./interjection-answer";
import { kindOf } from "./player-model";
import type { Place } from "./tab-props";

/** The frame kind a host seals when it holds the loop for a person. */
const INTERJECT = "control.interject";
/** The frame kind the answer to that question is recorded as. */
const ANSWER = "control.answer";
/** A wrapped run's model call: the frame the held loop has not reached. */
const MODEL_CALL = "llm_call";

/** The run's own `control.interject` frame, when its recording carries one. */
export function interjectionOf(detail: RunDetail): RunFrame | null {
  return (
    detail.frames.frames.find(
      (frame) => frame.chainRef === undefined && frame.type === INTERJECT,
    ) ?? null
  );
}

/**
 * The repository question the frame raised: the row whose `raisedSeq` is the
 * frame's seq, else the run's only repository question. A free-text question
 * on the same run is not this page's.
 */
function questionOf(
  items: readonly InterjectionItem[],
  frame: RunFrame,
): InterjectionItem | null {
  const repo = items.filter((item) => item.kind === "repo_unknown");
  return (
    repo.find((item) => item.raisedSeq === frame.seq) ??
    (repo.length === 1 ? (repo[0] ?? null) : null)
  );
}

/**
 * Where the question stands. `closed` is a window that ran out with no answer
 * recorded yet: the timeout writes its deny a moment later.
 */
type Stage = "waiting" | "closed" | "answered" | "timedOut";

function stageOf(
  row: InterjectionItem | null,
  answer: RunFrame | null,
  now: number,
): Stage {
  if (row === null) return answer === null ? "waiting" : "answered";
  if (row.path === "deny") return "timedOut";
  if (row.answeredAt !== null) return "answered";
  return Date.parse(row.expiresAt) <= now ? "closed" : "waiting";
}

/** `09:14:02Z`: an instant as the note and the panes print it. */
function clock(at: string, precise = false): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(11, precise ? 23 : 19)}Z`;
}

const strong = (chunks: ReactNode) => <strong>{chunks}</strong>;

function Pane({
  title,
  source,
  gold = false,
  testId,
  children,
}: {
  title: string;
  source: string;
  /** The one gold pane: what Oxagen put to a person. */
  gold?: boolean;
  testId: string;
  children: ReactNode;
}) {
  const id = `${testId}-title`;
  return (
    <section
      aria-labelledby={id}
      data-testid={testId}
      className={`${panel} flex flex-col ${gold ? "border-gold/60" : ""}`}
    >
      <div
        className={`flex items-center justify-between gap-3 border-b border-border px-4 py-3 ${gold ? "bg-gold/10" : ""}`}
      >
        <h2 id={id} className={eyebrow}>
          {title}
        </h2>
        <span className={`${mono} text-[11px] text-muted-foreground`}>
          {source}
        </span>
      </div>
      <div className="flex flex-col gap-3 p-4">{children}</div>
    </section>
  );
}

function FrameRow({
  type,
  summary,
  at,
}: {
  type: string;
  summary: string;
  /** Null for a frame that has not happened, drawn greyed and dashed. */
  at: string | null;
}) {
  const pending = at === null;
  return (
    <li
      data-testid={
        pending ? "interjection-frame-pending" : "interjection-frame"
      }
      data-kind={type}
      className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${pending ? "border-dashed border-border text-muted-foreground" : "border-border"}`}
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className={`${mono} font-semibold`}>{type}</span>{" "}
        <span className="text-muted-foreground">{summary}</span>
      </span>
      {at === null ? null : (
        <span className={`${mono} shrink-0 text-[11px] text-muted-foreground`}>
          {clock(at, true)}
        </span>
      )}
    </li>
  );
}

function Header({
  detail,
  row,
  stage,
}: {
  detail: RunDetail;
  row: InterjectionItem | null;
  stage: Stage;
}) {
  const t = useTranslations("run.interjection");
  const run = detail.run;
  const facts = [
    run.agentKey,
    run.harness?.name ?? null,
    run.operatorName,
    t("tier", { tier: run.enforcementTier }),
    row?.repository ?? null,
  ].filter((fact): fact is string => fact !== null);
  let status: ReactNode;
  switch (stage) {
    case "waiting":
      status = (
        <>
          <Badge tone="approval">{t("status.waiting")}</Badge>
          <span className="text-xs text-muted-foreground">
            {t("status.waitingCaption")}
          </span>
        </>
      );
      break;
    case "closed":
      status = <Badge tone="approval">{t("status.waiting")}</Badge>;
      break;
    // Once the question is settled, the header says what the run is doing,
    // as the ordinary Run page does: live while it works, its outcome once
    // it ends.
    case "answered":
    case "timedOut":
      status = <StatusBadge status={run.status} outcome={run.outcome} />;
      break;
  }
  return (
    <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="flex flex-wrap items-baseline gap-2">
          <span className={eyebrow}>{t("eyebrow")}</span>
          <span className={`${mono} text-[12px] text-muted-foreground`}>
            {run.id}
          </span>
        </p>
        <h1 className="text-[22px] font-bold leading-tight text-foreground [overflow-wrap:anywhere]">
          {run.name ?? run.taskRef ?? run.id}
        </h1>
        <ul
          aria-label={t("meta")}
          className={`${mono} flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground`}
        >
          {facts.map((fact) => (
            <li key={fact} className="[overflow-wrap:anywhere]">
              {fact}
            </li>
          ))}
        </ul>
      </div>
      <div
        data-testid="interjection-status"
        className="flex flex-none items-center gap-2"
      >
        {status}
      </div>
    </header>
  );
}

function Note({
  row,
  stage,
  interject,
  answer,
}: {
  row: InterjectionItem | null;
  stage: Stage;
  interject: RunFrame;
  answer: RunFrame | null;
}) {
  const t = useTranslations("run.interjection");
  let text: ReactNode;
  switch (stage) {
    case "waiting":
      text = t.rich("note.waiting", {
        at: clock(interject.observedAt),
        strong,
      });
      break;
    case "closed":
      text = t.rich("note.windowClosed", {
        at: clock(row?.expiresAt ?? interject.observedAt),
        strong,
      });
      break;
    case "answered": {
      const at = row?.answeredAt ?? answer?.observedAt ?? null;
      const said = row === null ? null : row.answer;
      text =
        at === null
          ? null
          : said === null
            ? t.rich("note.answeredUnrecorded", { at: clock(at), strong })
            : t.rich("note.answered", { at: clock(at), answer: said, strong });
      break;
    }
    case "timedOut":
      text = t.rich("note.timedOut", {
        at: clock(row?.answeredAt ?? row?.expiresAt ?? interject.observedAt),
        strong,
      });
      break;
  }
  if (text === null) return null;
  return (
    <p
      data-testid="interjection-note"
      className="rounded-md border-l-2 border-gold bg-gold/10 px-3.5 py-2.5 text-sm text-foreground"
    >
      {text}
    </p>
  );
}

/** Oxagen's question, and the answer or the reason there is none to give. */
function AgentView({
  question,
  row,
  stage,
  interject,
  place,
  canAnswer,
}: {
  question: Read<InterjectionQueue>;
  row: InterjectionItem | null;
  stage: Stage;
  interject: RunFrame;
  place: Place;
  canAnswer: boolean;
}) {
  const t = useTranslations("run.interjection");
  const open = stage === "waiting" || stage === "closed";
  return (
    <Pane
      title={t("panes.agent")}
      source={t("panes.agentSource")}
      testId="interjection-agent"
    >
      <div
        data-testid="interjection-question"
        className="flex flex-col gap-2 rounded-lg border-l-2 border-gold bg-app-panel-bg p-3"
      >
        <p className="flex items-center justify-between gap-2 text-sm font-semibold">
          <span className="flex items-center gap-2">
            {t("question.from")}
            <Badge tone="quiet" dot={false} mono>
              {t("question.label")}
            </Badge>
          </span>
          <span className={`${mono} text-[11px] text-muted-foreground`}>
            {clock(row?.raisedAt ?? interject.observedAt)}
          </span>
        </p>
        {!question.ok ? (
          <ReadFailure read={question} section={t("panes.operator")} />
        ) : row === null ? (
          <p
            data-testid="interjection-missing"
            className="text-sm text-muted-foreground"
          >
            {t("unavailable.missing")}
          </p>
        ) : (
          <p className="whitespace-pre-wrap text-sm">{row.question}</p>
        )}
        {row !== null && open ? (
          row.body === null ? (
            <p
              data-testid="interjection-no-body"
              className="text-sm text-muted-foreground"
            >
              {t("unavailable.noBody")}
            </p>
          ) : (
            <InterjectionAnswer
              org={place.org}
              ws={place.ws}
              interjectionId={row.id}
              body={row.body}
              repository={row.repository}
              canAnswer={canAnswer}
              closedAt={stage === "closed" ? clock(row.expiresAt) : null}
            />
          )
        ) : null}
      </div>
      {row !== null && !open && row.answeredAt !== null ? (
        <div
          data-testid="interjection-reply"
          className="flex flex-col gap-1.5 rounded-lg border border-l-2 border-border border-l-foreground/40 bg-app-panel-bg p-3"
        >
          <p className="flex items-center justify-between gap-2 text-sm font-semibold">
            <span className="flex min-w-0 items-center gap-2">
              {row.answeredBy === null ? (
                t("reply.timeout")
              ) : (
                <span className={`${mono} [overflow-wrap:anywhere]`}>
                  {row.answeredBy}
                </span>
              )}
              <Badge tone="quiet" dot={false} mono>
                {t("reply.label")}
              </Badge>
            </span>
            <span className={`${mono} text-[11px] text-muted-foreground`}>
              {clock(row.answeredAt)}
            </span>
          </p>
          {row.answer === null ? null : (
            <p className="whitespace-pre-wrap text-sm">{row.answer}</p>
          )}
        </div>
      ) : null}
    </Pane>
  );
}

/** The recorded answer: who, which path, the receipt and the wait. */
function AnswerRecord({
  row,
  answeredAt,
  place,
}: {
  row: InterjectionItem;
  answeredAt: string;
  place: Place;
}) {
  const t = useTranslations("run.interjection");
  const locale = useLocale();
  let path: string;
  switch (row.path) {
    case "link":
      path = t("answer.paths.link");
      break;
    case "create":
      path = t("answer.paths.create");
      break;
    case "deny":
      path = t("answer.paths.deny");
      break;
    case null:
      path = t("answer.pathNotRecorded");
      break;
  }
  return (
    <section
      aria-labelledby="interjection-answer-title"
      data-testid="interjection-answer"
      className="flex flex-col gap-2.5 rounded-lg border border-border p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <h3
            id="interjection-answer-title"
            className="text-sm font-semibold"
          >
            {t("answer.title")}
          </h3>
          <Badge tone="quiet" dot={false}>
            {t("answer.closed")}
          </Badge>
        </span>
        <span className={`${mono} text-[11px] text-muted-foreground`}>
          {clock(answeredAt)}
        </span>
      </div>
      <dl className={kvList}>
        <dt className={kvTerm}>{t("answer.by")}</dt>
        <dd className={`${kvValue} ${row.answeredBy === null ? "" : mono}`}>
          {row.answeredBy ?? t("answer.byTimeout")}
        </dd>
        <dt className={kvTerm}>{t("answer.path")}</dt>
        <dd className={kvValue}>{path}</dd>
        <dt className={kvTerm}>{t("answer.receipt")}</dt>
        <dd
          data-testid="interjection-answer-receipt"
          className={`${kvValue} ${row.receiptId === null ? "" : mono}`}
        >
          {row.receiptId ?? t("answer.receiptNotRecorded")}
        </dd>
        <dt className={kvTerm}>{t("answer.waited")}</dt>
        <dd className={`${kvValue} ${mono}`}>
          {formatDuration(
            Date.parse(answeredAt) - Date.parse(row.raisedAt),
            locale,
          )}
        </dd>
      </dl>
      <SafeLink
        to={routes.run(place.org, place.ws, place.runId, {
          tab: "transcript",
        })}
        data-testid="interjection-transcript"
        className={`${linkText} text-sm`}
      >
        {t("answer.transcript")}
      </SafeLink>
    </section>
  );
}

function OperatorQuestion({
  row,
  stage,
  interject,
  place,
}: {
  row: InterjectionItem | null;
  stage: Stage;
  interject: RunFrame;
  place: Place;
}) {
  const t = useTranslations("run.interjection");
  const open = stage === "waiting" || stage === "closed";
  const body = row?.body ?? null;
  return (
    <Pane
      title={t("panes.operator")}
      source={t("panes.operatorSource")}
      gold
      testId="interjection-operator"
    >
      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <p className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <span className={`${mono} font-semibold`}>{INTERJECT}</span>
            {open ? (
              <Badge tone="denied" dot={false}>
                {t("held")}
              </Badge>
            ) : null}
          </span>
          <span className={`${mono} text-[11px] text-muted-foreground`}>
            {clock(interject.observedAt)}
          </span>
        </p>
        {row === null ? null : (
          <p
            data-testid="interjection-repository"
            className="text-sm [overflow-wrap:anywhere]"
          >
            {row.repository === null
              ? t("repositoryUnresolved")
              : t("repository", { repository: row.repository })}
          </p>
        )}
      </div>
      {open && row !== null && body !== null ? (
        <section
          aria-labelledby="interjection-timeout-title"
          data-testid="interjection-timeout"
          className="flex flex-col gap-1 rounded-lg border border-border p-3"
        >
          <h3
            id="interjection-timeout-title"
            className="text-sm font-semibold"
          >
            {t("timeout.title")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("timeout.body", {
              minutes: Math.round(body.timeoutMs / 60_000),
            })}
          </p>
          {stage === "waiting" ? (
            <p className="text-xs text-muted-foreground">
              {t("timeout.closes", { at: clock(row.expiresAt) })}
            </p>
          ) : null}
        </section>
      ) : null}
      {!open && row !== null && row.answeredAt !== null ? (
        <AnswerRecord row={row} answeredAt={row.answeredAt} place={place} />
      ) : null}
    </Pane>
  );
}

/**
 * The frames on the run's own chain up to its first model call, and greyed
 * rows for what has not happened: the answer while the question is open, and
 * the first model call while none is recorded. A read that stopped before the
 * end of the recording claims neither, and says it stopped.
 */
function Frames({
  detail,
  stage,
}: {
  detail: RunDetail;
  stage: Stage;
}) {
  const t = useTranslations("run.interjection");
  const root = detail.frames.frames.filter(
    (frame) => frame.chainRef === undefined,
  );
  const call = root.findIndex((frame) => kindOf(frame.type) === "model");
  const shown = call === -1 ? root : root.slice(0, call + 1);
  const cut = detail.frames.more;
  const answered = root.some((frame) => frame.type === ANSWER);
  const open = stage === "waiting" || stage === "closed";
  return (
    <Pane
      title={t("panes.frames")}
      source={t("panes.framesSource")}
      testId="interjection-frames"
    >
      <ol className="flex flex-col gap-2">
        {shown.map((frame) => (
          <FrameRow
            key={frame.seq}
            type={frame.type}
            summary={frame.summary}
            at={frame.observedAt}
          />
        ))}
        {open && !answered ? (
          <FrameRow type={ANSWER} summary={t("frames.pending")} at={null} />
        ) : null}
        {call === -1 && !cut ? (
          <FrameRow
            type={MODEL_CALL}
            summary={t("frames.firstCall")}
            at={null}
          />
        ) : null}
      </ol>
      {cut ? (
        <p className="text-xs text-muted-foreground">{t("frames.cut")}</p>
      ) : null}
    </Pane>
  );
}

export function RunInterjection({
  detail,
  interject,
  question,
  place,
  orgRole,
  wsRole,
  now,
}: {
  detail: RunDetail;
  /** The run's own `control.interject` frame. */
  interject: RunFrame;
  /** `interjections.forRun`: the run's questions, answered or not. */
  question: Read<InterjectionQueue>;
  place: Place;
  orgRole: OrgRole;
  wsRole: WsRole;
  /** The instant the page read the run, which closes a window that ran out. */
  now: number;
}) {
  const row = question.ok ? questionOf(question.value.items, interject) : null;
  const answer =
    detail.frames.frames.find(
      (frame) => frame.chainRef === undefined && frame.type === ANSWER,
    ) ?? null;
  const stage = stageOf(row, answer, now);
  return (
    <div
      data-testid="run-interjection"
      data-stage={stage}
      className="flex flex-col gap-5"
    >
      <Header detail={detail} row={row} stage={stage} />
      <Note row={row} stage={stage} interject={interject} answer={answer} />
      <div className="grid grid-cols-1 gap-4 min-[67.5rem]:grid-cols-3">
        <AgentView
          question={question}
          row={row}
          stage={stage}
          interject={interject}
          place={place}
          canAnswer={canAnswerRepositoryQuestion(orgRole, wsRole)}
        />
        <OperatorQuestion
          row={row}
          stage={stage}
          interject={interject}
          place={place}
        />
        <Frames detail={detail} stage={stage} />
      </div>
    </div>
  );
}
