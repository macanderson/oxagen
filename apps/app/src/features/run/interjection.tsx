// The Run page for a run whose loop Oxagen stopped on an interjection (spec
// pages/run-interjection.md): the same route as an ordinary run, drawn as
// three panes. What the agent shows its operator, what Oxagen put to a person,
// and what was written down.
//
// A run is drawn this way only when its recording carries a
// `control.interject` frame. Everything here that the record holds is read
// from the frames: the header, the status, the note's timestamp, and the
// whole frames pane. The question's text, the consequences of each path, the
// timeout and the answer write are not on any record yet, so each of those
// says so in place, and Send this answer stays disabled rather than accepting
// a click that would do nothing. Nothing here renders a frame that was not
// written: the frames that follow an answer are drawn greyed, as not yet
// happened, until the recording carries them.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RunDetail, RunFrame } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import { Badge } from "@/ui/badge";
import { eyebrow, mono, panel } from "@/ui/control-styles";
import { InterjectionAnswer } from "./interjection-answer";

/** The frame kind that marks a run as held on an interjection. */
export const INTERJECT = "control.interject";
const ANSWER = "control.answer";
/** The frames the spec lists after an answer, in order, while the run waits. */
const AFTER_ANSWER = [
  "skills.resolved",
  "context.assembled",
  "model.request",
] as const;

/** The run's interjection frame, when its recording carries one. */
export function interjectionOf(detail: RunDetail): RunFrame | null {
  return detail.frames.frames.find((frame) => frame.type === INTERJECT) ?? null;
}

/** `09:14:02Z`: the instant a frame recorded, as the note and the panes print it. */
function clock(at: string, precise = false): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(11, precise ? 23 : 19)}Z`;
}

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
  frame,
  pending,
}: {
  frame: { type: string; summary: string; at: string | null };
  /** Drawn greyed and dashed: a frame that has not happened. */
  pending: boolean;
}) {
  return (
    <li
      data-testid={
        pending ? "interjection-frame-pending" : "interjection-frame"
      }
      className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${pending ? "border-dashed border-border text-muted-foreground" : "border-border"}`}
    >
      <span className="min-w-0">
        <span className={`${mono} font-semibold`}>{frame.type}</span>{" "}
        <span className="text-muted-foreground">{frame.summary}</span>
      </span>
      <span className={`${mono} shrink-0 text-[11px] text-muted-foreground`}>
        {frame.at === null ? null : clock(frame.at, true)}
      </span>
    </li>
  );
}

export function RunInterjection({
  detail,
  interject,
  ws,
}: {
  detail: RunDetail;
  /** The run's `control.interject` frame. */
  interject: RunFrame;
  /** The workspace the page sits in: the one the Link path names. */
  ws: string;
}) {
  const t = useTranslations("run.interjection");
  const run: RunRow = detail.run;
  const frames = detail.frames.frames;
  const answer = frames.find((frame) => frame.type === ANSWER) ?? null;
  const operator = run.operatorName ?? t("operatorNotRecorded");
  const firstName = operator.split(" ")[0] ?? operator;
  const title =
    (run.enrichmentEnabled === false ? null : run.name) ??
    run.taskRef ??
    run.id;
  const recorded = new Set(frames.map((frame) => frame.type));
  const greyed =
    answer === null ? AFTER_ANSWER.filter((kind) => !recorded.has(kind)) : [];
  const after = frames.filter(
    (frame) =>
      frame.type === "skills.loaded" || frame.type === "workspace.created",
  );
  const meta = [
    run.agentKey,
    run.harness?.name ?? null,
    run.operatorName,
    t("tier", { tier: run.enforcementTier }),
  ].filter((part): part is string => part !== null);
  return (
    <div data-testid="run-interjection" className="flex flex-col gap-5">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className={eyebrow}>{t("eyebrow", { id: run.id })}</p>
          <h1 className="text-[22px] font-bold leading-tight text-foreground">
            {title}
          </h1>
          <p
            aria-label={t("meta")}
            className={`${mono} text-[12.5px] text-muted-foreground`}
          >
            {meta.join(" · ")}
          </p>
        </div>
        <Badge tone={answer === null ? "approval" : "allowed"}>
          {answer === null ? t("waiting") : t("live")}
        </Badge>
      </header>
      <p
        data-testid="interjection-note"
        className="rounded-md border-l-2 border-gold bg-gold/10 px-3.5 py-2.5 text-sm text-foreground"
      >
        {answer === null
          ? t.rich("noteWaiting", {
              at: clock(interject.observedAt),
              strong: (chunks) => <strong>{chunks}</strong>,
            })
          : t.rich("noteAnswered", {
              at: clock(answer.observedAt),
              summary: answer.summary,
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
      </p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Pane
          title={t("agentPane", { name: firstName })}
          source={t("agentSource")}
          testId="interjection-agent"
        >
          <div className="flex flex-col gap-2 rounded-lg border-l-2 border-gold bg-app-panel-bg p-3">
            <p className="flex items-center justify-between gap-2 text-sm font-semibold">
              <span className="flex items-center gap-2">
                {t("oxagenSource")}
                <Badge tone="quiet" dot={false} mono>
                  {t("label")}
                </Badge>
              </span>
              <span className={`${mono} text-[11px] text-muted-foreground`}>
                {clock(interject.observedAt)}
              </span>
            </p>
            <p
              data-gap="interjection-question"
              className="text-sm text-muted-foreground"
            >
              {t("questionNotRecorded")}
            </p>
            {answer === null ? (
              <InterjectionAnswer ws={ws} operator={operator} />
            ) : null}
          </div>
          <p className="border-l-2 border-gold pl-3 text-xs text-muted-foreground">
            {t("reachNote", { name: firstName })}
          </p>
        </Pane>
        <Pane
          title={t("oxagenPane")}
          source={t("oxagenSource")}
          gold
          testId="interjection-oxagen"
        >
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <p className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span className={`${mono} font-semibold`}>{INTERJECT}</span>
                <Badge tone="denied" dot={false}>
                  {t("held")}
                </Badge>
              </span>
              <span className={`${mono} text-[11px] text-muted-foreground`}>
                {clock(interject.observedAt)}
              </span>
            </p>
            <p className="text-sm">{interject.summary}</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(["linkPath", "createPath"] as const).map((path) => (
              <section
                key={path}
                aria-labelledby={`interjection-${path}`}
                className="flex flex-col gap-1.5 rounded-lg border border-border p-3"
              >
                <h3
                  id={`interjection-${path}`}
                  className="text-sm font-semibold"
                >
                  {t(path)}
                </h3>
                {path === "linkPath" ? (
                  <p className="text-xs text-muted-foreground">
                    {t("linkTo", { ws })}
                  </p>
                ) : null}
                <p
                  data-gap="interjection-consequences"
                  className="text-xs text-muted-foreground"
                >
                  {t("consequencesNotRecorded")}
                </p>
              </section>
            ))}
          </div>
          <section
            aria-labelledby="interjection-timeout"
            className="rounded-lg border border-border p-3"
          >
            <h3
              id="interjection-timeout"
              className={`${mono} text-sm font-semibold`}
            >
              {t("timeoutTitle")}
            </h3>
            <p
              data-gap="interjection-timeout"
              className="text-xs text-muted-foreground"
            >
              {t("timeoutNotRecorded")}
            </p>
          </section>
        </Pane>
        <Pane
          title={t("framesPane")}
          source={t("framesSource")}
          testId="interjection-frames"
        >
          <ol className="flex flex-col gap-2">
            {frames.map((frame) => (
              <FrameRow
                key={frame.seq}
                frame={{
                  type: frame.type,
                  summary: frame.summary,
                  at: frame.observedAt,
                }}
                pending={false}
              />
            ))}
            {answer === null ? (
              <FrameRow
                frame={{ type: ANSWER, summary: t("pending"), at: null }}
                pending
              />
            ) : null}
            {greyed.map((kind) => (
              <FrameRow
                key={kind}
                frame={{ type: kind, summary: t("waitsOn"), at: null }}
                pending
              />
            ))}
          </ol>
          {detail.frames.more ? (
            <p className="text-xs text-muted-foreground">{t("cut")}</p>
          ) : null}
          {greyed.length === 0 ? null : (
            <p className="border-l-2 border-gold pl-3 text-xs text-muted-foreground">
              {t("notHappened", { count: String(greyed.length) })}
            </p>
          )}
        </Pane>
      </div>
      {after.map((frame) => (
        <section
          key={frame.seq}
          aria-labelledby={`interjection-after-${frame.seq}`}
          className={`${panel} p-4`}
        >
          <h2
            id={`interjection-after-${frame.seq}`}
            className="text-base font-semibold"
          >
            {frame.type === "skills.loaded"
              ? t("skillLoaded")
              : t("workspaceCreated")}
          </h2>
          <p className="pt-2 text-sm text-muted-foreground">{frame.summary}</p>
        </section>
      ))}
    </div>
  );
}
