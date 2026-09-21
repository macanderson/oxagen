"use client";
// The transcript and its transport (mockup `pRun`, `renderTranscript` and
// `renderTransport`): every run reads the same way, from the run's start
// through each turn, each turn's steps on a spine, and each step's frames
// behind a disclosure.
//
// The transport moves the viewer, never the run. Its position is a frame;
// playback walks the frames at their recorded pace, idle longer than 2 s
// compressed, and the readout puts the true elapsed time and the cost to
// that point beside the position. Frames past the position are dimmed, and
// the step holding it is marked.
//
// Zoom is which disclosures start open (Turns: none, Steps: the turns,
// Everything: the turns and their steps), not a different read, so a change
// of level keeps the position and rewrites only the query value.
//
// A live run follows its own head over the SSE route
// (`GET /v1/:org/:ws/runs/:run_id/stream`, reached same-origin through the
// `/api/v1/*` rewrite). The stream carries frames, and the transcript carries
// entries the contract derives from them, so a frame landing is the signal to
// read the tail rather than something to render: deriving an entry here would
// put a second, weaker copy of the contract's derivation on the page.
// Scrubbing back stops following, and "go live" resumes it; a sealed or halted
// run is never followed.
//
// A run longer than one read is paged rather than truncated. The read answers
// a cursor, "Read more" asks for the next page, and playback reads ahead of
// the playhead so it does not stall at a page boundary. Entries are appended,
// never replaced, so the scroll position and the playhead stay where they are.
// A cursor this capability did not write is refused, and the view says so
// instead of starting the transcript again.
import { useLocale, useTranslations } from "next-intl";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Money as MoneyValue } from "@/data/contracts/money";
import {
  type RunTranscript,
  TRANSCRIPT_ENTRY_DEFAULT,
  TRANSCRIPT_ZOOMS,
  type TranscriptBody,
  type TranscriptDecision,
  type TranscriptEntry,
  type TranscriptKind,
  type TranscriptZoom,
} from "@/data/contracts/run";
import type { ReplayGrade, RunStatus } from "@/data/contracts/runs";
import { languageForPath } from "@/shared/code-highlight";
import { routes } from "@/shared/safe-path";
import { CodePanel, DiffPanel } from "@/ui/code-panel";
import { linkText } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatClock, formatCount, formatDuration } from "@/ui/money-format";
import { SafeLink, useNavigate } from "@/ui/navigation";
import type { ActionResult } from "@/server/kernel";
import { readTranscriptPage } from "./actions";
import type { ToolDetail } from "./tool-detail";
import { StepIcon } from "./tool-icon";
import { kindsParam } from "./transcript";
import {
  buildTranscript,
  decisionSubject,
  type Frames,
  frameAt,
  frameCost,
  idsAt,
  openAtZoom,
  playDelay,
  type StepDigest,
  type StepNode,
  stepDigest,
  stepTool,
  toolExchange,
  type TranscriptStep,
  type TranscriptTurn,
  visibleFrames,
} from "./transcript-model";
import { useRunStream } from "./use-run-stream";

type Place = { org: string; ws: string; runId: string };

/** Why a later page did not arrive, in the shape the action answers with. */
type PageFailure = Exclude<ActionResult<unknown>, { ok: true }>;

const SPEEDS = [1, 1.5, 2, 4] as const;
/** How close to the end the playhead gets before the next page is read ahead of it. */
const PREFETCH_WITHIN = 5;

/*
 * A step's kind is a STATE, and the house rule is that the gold never encodes
 * one: it is identity, and at most one action per screen. So `control` — a
 * frame Oxagen itself wrote, a steer or a pause — is told apart by SHAPE, the
 * square dot among round ones, which is also the only difference that survives
 * greyscale and colour blindness. It used to take the gold, which put the
 * brand metal inside the same axis as info, success and destructive.
 */
const DOT: Record<StepNode, string> = {
  model: "border-info",
  tool: "border-muted-foreground",
  policy: "border-success",
  control: "border-foreground rounded-[2px]",
  deny: "border-destructive bg-destructive",
};
const NAME: Record<StepNode, string> = {
  model: "text-info",
  tool: "text-foreground",
  policy: "text-foreground",
  control: "text-foreground",
  deny: "text-destructive",
};

const chip =
  "whitespace-nowrap rounded-full border border-border bg-card px-2 font-mono text-[10.5px] leading-[1.8] text-muted-foreground";
const segButton =
  "border-r border-border px-2 py-1 text-[11px] text-muted-foreground last:border-r-0 hover:text-foreground aria-pressed:bg-card aria-pressed:font-semibold aria-pressed:text-foreground";
const tpButton =
  "grid size-[30px] shrink-0 place-items-center rounded-md border border-border bg-card text-foreground hover:border-foreground/40 disabled:cursor-not-allowed disabled:opacity-35";

function Chevron() {
  return (
    <span
      aria-hidden="true"
      className="inline-block w-2.5 shrink-0 text-[8px] text-muted-foreground transition-transform group-open:rotate-90"
    >
      ▶
    </span>
  );
}

function Chip({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "cost" | "warn";
}) {
  return (
    <span
      className={`${chip} ${tone === "cost" ? "text-foreground" : tone === "warn" ? "text-destructive" : ""}`}
    >
      {children}
    </span>
  );
}

/**
 * The decision a rule or a person made, and the call it was made on.
 *
 * The subject is the point: a line that says a decision was `allow` and not
 * what was allowed is a line a reader has to open the envelope to act on.
 * It falls back to the decision alone where the frame recorded no tool,
 * which a gate on something other than a tool call legitimately does.
 */
function Decision({
  decision,
  subject,
}: {
  decision: TranscriptDecision;
  subject: string | null;
}) {
  const t = useTranslations("run.transcript");
  return (
    <p
      data-testid="entry-decision"
      className="m-0 text-xs text-muted-foreground"
    >
      {subject === null
        ? t("decision", { decision: decision.decision, seq: decision.seq })
        : t("decisionOn", {
            decision: decision.decision,
            subject,
            seq: decision.seq,
          })}
    </p>
  );
}

/**
 * One half of an exchange: what went out, or what came back. The label says
 * which, so a reader never has to work out whether a body is an input or a
 * result, and a half whose bytes were not retained says so rather than
 * drawing an empty box.
 */
function FrameHalf({
  body,
  label,
  seq,
  text,
  org,
  ws,
  runId,
}: {
  body: TranscriptBody;
  label: string;
  seq: string;
  /** The text to draw in place of the body's own, when the body was read apart. */
  text?: string;
} & Place) {
  const t = useTranslations("run.transcript");
  const shown = text ?? body.text;
  return (
    <div
      data-testid="transcript-half"
      data-half={label}
      className="flex flex-col gap-1.5"
    >
      <span className="text-[10.5px] font-medium text-muted-foreground">
        {label}
      </span>
      {shown === null ? (
        <p className="m-0 text-xs text-muted-foreground">
          {t(body.fidelity === "digest_only" ? "digestOnly" : "noBody")}
        </p>
      ) : (
        <pre className="m-0 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-2.5 font-mono text-[11.5px] leading-relaxed text-foreground">
          {shown}
        </pre>
      )}
      {body.truncated ? (
        <p
          data-testid="entry-truncated"
          className="m-0 text-xs text-muted-foreground"
        >
          {t("truncated")}{" "}
          <SafeLink
            to={routes.run(org, ws, runId, { tab: "frames", body: seq })}
            className={linkText}
          >
            {t("openFrame", { seq })}
          </SafeLink>
        </p>
      ) : null}
    </div>
  );
}

function FrameDetail({
  frame,
  org,
  ws,
  runId,
}: { frame: TranscriptEntry } & Place) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const place = { org, ws, runId };
  // The halves are read by name, never positionally. At `everything` a frame
  // carries one of them; at a folded zoom a tool step carries its input in
  // `request` and its result in `response`, and both are drawn. Picking one of
  // the two would put a tool's input where its result belongs, and the page
  // would look no different for it.
  const { request, response } = frame;
  const both = request !== null && response !== null;
  // A tool was called with its input and returned its result; every other kind
  // sent and received. The words differ because the actions do.
  const sent = frame.kind === "tool_call" ? t("calledWith") : t("request");
  // The header names one fidelity, and the one a reader is here for is the
  // result's: a step whose input was kept and whose result was not is a step
  // with no result to read. Where no result was recorded the outgoing half is
  // the only half, so it is the one named. This is a summary and never the
  // only place the fidelity appears. Each half below states its own, so it
  // is a deliberate choice of which to headline, not a pick between two
  // bodies. The bodies themselves are read by name.
  const headline = response ?? request;
  const neither = request === null && response === null;
  // A wrapped session's tool receipt is one body holding the input and the
  // output. Drawn as one "Returned" block it read as a JSON blob with the
  // call's arguments buried inside; read apart, each half gets its own label.
  const exchange =
    frame.kind === "tool_call" && request === null && response?.text
      ? toolExchange(response.text)
      : null;
  return (
    <div
      data-testid="transcript-frame"
      className="border-b border-border last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-1.5">
        <span className="font-mono text-[11px] text-foreground">
          {frame.type}
        </span>
        <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
          {t("frameHead", {
            seq: frame.seq,
            // Run-relative, not wall-clock: a frame's place in the run is
            // what a reader is locating, and it is the reading the transport
            // below counts in. The absolute instant stays on the step rail's
            // `dateTime`, so nothing the record holds is dropped.
            time: formatDuration(frame.elapsedMs, locale),
            fidelity: t(`fidelity.${headline?.fidelity ?? "digest_only"}`),
          })}
        </span>
      </div>
      <div className="flex flex-col gap-2 px-3 py-2.5">
        {frame.label !== frame.type ? (
          <p className="m-0 font-mono text-[11.5px] text-muted-foreground">
            {frame.label}
          </p>
        ) : null}
        {frame.decision === null ? null : (
          <Decision
            decision={frame.decision}
            subject={decisionSubject(frame)}
          />
        )}
        {neither ? (
          <p
            data-testid="entry-no-halves"
            className="m-0 text-xs text-muted-foreground"
          >
            {t("noHalves")}
          </p>
        ) : exchange !== null && response !== null ? (
          <>
            <FrameHalf
              body={response}
              label={t("calledWith")}
              seq={response.seq}
              text={exchange.input}
              {...place}
            />
            <FrameHalf
              body={response}
              label={t("response")}
              seq={response.seq}
              text={exchange.output}
              {...place}
            />
          </>
        ) : (
          <>
            {request === null ? null : (
              <FrameHalf
                body={request}
                label={both ? sent : t("request")}
                seq={request.seq}
                {...place}
              />
            )}
            {response === null ? null : (
              <FrameHalf
                body={response}
                label={t("response")}
                seq={response.seq}
                {...place}
              />
            )}
          </>
        )}
        {headline?.truncated === true ? null : (
          <SafeLink
            to={routes.run(org, ws, runId, { tab: "frames", body: frame.seq })}
            className={`${linkText} self-start text-[11px]`}
          >
            {t("envelope", { seq: frame.seq })}
          </SafeLink>
        )}
      </div>
    </div>
  );
}

/**
 * What a tool step did, drawn as the thing it is: a command as shell source,
 * an edit as a diff, a file's contents as numbered lines, a brief as prose.
 *
 * This is the half of the step a reader came for, so it sits above the frame
 * envelopes rather than below them. It is a *reading* of the record and never
 * a replacement for it: every byte it draws came out of a body the recorder
 * kept, and the frames it was read from are directly beneath, unchanged, with
 * their digests and their links into the Frames tab.
 */
function ToolPanes({ detail }: { detail: ToolDetail }) {
  const t = useTranslations("run.transcript");
  if (detail.panes.length === 0) return null;
  return (
    <div data-testid="tool-panes" className="flex flex-col gap-2 pb-2.5">
      {detail.panes.map((pane, index) => {
        const key = `${pane.kind}-${pane.label}-${index}`;
        if (pane.kind === "diff") {
          return (
            <DiffPanel
              key={key}
              diff={pane.diff}
              path={pane.path}
              language={languageForPath(pane.path)}
              label={t(`pane.${pane.label}`)}
            />
          );
        }
        if (pane.kind === "note") {
          return (
            <div
              key={key}
              className="overflow-hidden rounded-md border border-border bg-code-bg"
            >
              <div className="border-b border-border px-2.5 py-1 font-mono text-[10.5px] tracking-[0.08em] text-muted-foreground uppercase">
                {t(`pane.${pane.label}`)}
              </div>
              <p className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 text-[12px] leading-relaxed text-foreground">
                {pane.text}
              </p>
            </div>
          );
        }
        return (
          <CodePanel
            key={key}
            code={pane.text}
            language={pane.language}
            startLine={pane.startLine}
            preview={pane.preview}
            label={t(`pane.${pane.label}`)}
            expandLabel={t("showAll")}
          />
        );
      })}
    </div>
  );
}

function StepRow({
  step,
  digest,
  pos,
  open,
  onToggle,
  place,
}: {
  step: TranscriptStep;
  digest: StepDigest;
  pos: number;
  open: boolean;
  onToggle: (id: string, open: boolean) => void;
  place: Place;
}) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const { first } = step;
  const isNow = pos >= step.from && pos <= step.to;
  const isFuture = step.from > pos;
  // Held across renders because it parses the recorded body, where the digest
  // beside it is cheap enough to recompute.
  const detail = useMemo(() => stepTool(step), [step]);
  // The tool's own name beats the label's first word wherever the body was
  // kept. A skill load is the one exception: it is the step that changes what
  // the agent CAN do rather than recording what it did, so the line says so
  // in words — `Loaded skill file-inbox`, not `Skill file-inbox`.
  const name =
    detail?.group === "skill"
      ? t("loadedSkill")
      : (detail?.name ?? digest.name);
  // The headline read out of the body says what the call acted on — a
  // command, a path, a pattern — where `digest.arg` had only the frame's
  // label, which for a tool is the tool's name a second time.
  const arg = detail?.headline ?? digest.arg;
  // A detail with nothing to draw — every body was `digest_only` — is not a
  // reading of the step, so the frames below stay open rather than folding
  // behind a disclosure that would reveal nothing new.
  const panes = detail === null || detail.panes.length === 0 ? null : detail;
  return (
    <details
      data-testid="transcript-step"
      data-node={digest.node}
      data-now={isNow ? "true" : undefined}
      open={open}
      onToggle={(e) => {
        onToggle(step.id, e.currentTarget.open);
      }}
      className={`group border-b border-border last:border-b-0 ${isFuture ? "opacity-35" : ""}`}
    >
      <summary
        className={`cursor-pointer list-none py-1.5 pr-3 select-none hover:bg-muted [&::-webkit-details-marker]:hidden ${isNow ? "bg-muted shadow-[inset_3px_0_0_var(--color-brand)]" : ""}`}
      >
        <div className="grid grid-cols-[46px_30px_1fr] items-baseline">
          <time
            dateTime={first.at}
            className="pr-2 text-right font-mono text-[10.5px] tabular-nums text-muted-foreground"
          >
            {formatClock(first.elapsedMs / 1000, locale)}
          </time>
          <span className="relative text-center before:absolute before:-top-3 before:-bottom-3 before:left-1/2 before:w-px before:bg-border">
            <span
              aria-hidden="true"
              className={`relative z-10 inline-block size-[7px] rounded-full border-2 bg-card ${DOT[digest.node]}`}
            />
          </span>
          <span className="flex min-w-0 flex-wrap items-baseline gap-2">
            <Chevron />
            <span
              className={`flex shrink-0 items-baseline gap-1.5 font-mono text-xs font-semibold ${NAME[digest.node]}`}
            >
              {/* The mark takes its colour from this span, so the palette on
                  the rail stays the four the node already spends and a new
                  tool family can never add a fifth. */}
              <StepIcon node={digest.node} group={detail?.group ?? null} />
              {name}
            </span>
            {arg === null ? null : (
              <span className="max-w-[46ch] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11.5px] text-muted-foreground">
                {arg}
              </span>
            )}
            {detail?.detail == null ? null : (
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/80">
                {detail.detail}
              </span>
            )}
            <span className="ml-auto flex flex-wrap gap-1.5">
              {digest.outcome === null ? null : (
                <Chip tone={digest.node === "deny" ? "warn" : undefined}>
                  {digest.outcome}
                </Chip>
              )}
              {digest.status === null ? null : (
                <Chip tone={digest.node === "deny" ? "warn" : undefined}>
                  {digest.status}
                </Chip>
              )}
              {digest.durationMs === null ? null : (
                <Chip>
                  {t("ms", { ms: formatCount(digest.durationMs, locale) })}
                </Chip>
              )}
              {digest.repeats !== null ? (
                <Chip>
                  <span data-testid="step-repeats">
                    {t("repeats", {
                      count: formatCount(digest.repeats, locale),
                    })}
                  </span>
                </Chip>
              ) : step.frames.length > 1 ? (
                <Chip>{t("frameCount", { count: step.frames.length })}</Chip>
              ) : null}
              {digest.cost === null ? null : (
                <Chip tone="cost">
                  <Money value={digest.cost} precision="exact" />
                </Chip>
              )}
            </span>
          </span>
        </div>
      </summary>
      {open ? (
        <div className="pr-3 pb-2.5 pl-3 md:pl-[76px]">
          {panes === null ? null : <ToolPanes detail={panes} />}
          {/* The record under the reading of it. Where the panes above already
              say what the step did, the envelopes they were read from fold
              away behind one more click — still one step away, never a page
              away — and where there are no panes the frames ARE the reading,
              so they stay open. A digest-only duplicate of a frame whose body
              is already shown elsewhere in the step is left out here too. */}
          {panes === null ? (
            <div className="overflow-hidden rounded-md border border-border bg-background">
              {visibleFrames(step).map((frame) => (
                <FrameDetail key={frame.seq} frame={frame} {...place} />
              ))}
            </div>
          ) : (
            <details className="group/raw overflow-hidden rounded-md border border-border bg-background">
              <summary className="cursor-pointer list-none px-3 py-1.5 text-[11px] text-muted-foreground select-none hover:text-foreground group-open/raw:border-b group-open/raw:border-border [&::-webkit-details-marker]:hidden">
                <span
                  aria-hidden="true"
                  className="mr-1.5 inline-block text-[8px] transition-transform group-open/raw:rotate-90"
                >
                  ▶
                </span>
                {t("frameCount", { count: step.frames.length })}
              </summary>
              {visibleFrames(step).map((frame) => (
                <FrameDetail key={frame.seq} frame={frame} {...place} />
              ))}
            </details>
          )}
        </div>
      ) : null}
    </details>
  );
}

function Role({ who, text }: { who: "you" | "agent"; text: string }) {
  const t = useTranslations("run.transcript");
  return (
    <div
      data-testid={`transcript-${who}`}
      className="grid grid-cols-1 border-b border-border py-2.5 pr-3 pl-3 md:grid-cols-[74px_1fr] md:pl-0"
    >
      <div className="pb-1.5 md:pr-3 md:pb-0 md:text-right">
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-[9.5px] font-bold tracking-[0.13em] text-background ${who === "you" ? "bg-info" : "bg-muted-foreground"}`}
        >
          {t(who)}
        </span>
      </div>
      <p
        className={`m-0 max-w-[70ch] whitespace-pre-wrap text-[13px] leading-relaxed text-foreground ${who === "agent" ? "border-l-2 border-border pl-3" : ""}`}
      >
        {text}
      </p>
    </div>
  );
}

function TurnBlock({
  turn,
  pos,
  running,
  openIds,
  onToggle,
  place,
}: {
  turn: TranscriptTurn;
  pos: number;
  running: boolean;
  openIds: Set<string>;
  onToggle: (id: string, open: boolean) => void;
  place: Place;
}) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const { first, last } = turn;
  const cost = frameCost(turn.frames);
  const seconds = (Date.parse(last.at) - Date.parse(first.at)) / 1000;
  return (
    <>
      {/* What was asked sits ABOVE the turn it opened, outside the
          disclosure, so it is the first thing on the transcript and it is
          there at every zoom. Inside the disclosure it was the one line a
          reader needed to read the rest and the one line a collapsed turn
          hid. */}
      {turn.prompt === null ? null : <Role who="you" text={turn.prompt} />}
      <details
        data-testid="transcript-turn"
        open={openIds.has(turn.id)}
        onToggle={(e) => {
          onToggle(turn.id, e.currentTarget.open);
        }}
        className="group/turn"
      >
        <summary className="cursor-pointer list-none border-b border-border bg-muted px-3 py-2.5 select-none hover:bg-card [&::-webkit-details-marker]:hidden">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <span
              aria-hidden="true"
              className="inline-block w-2.5 shrink-0 text-[8px] text-muted-foreground transition-transform group-open/turn:rotate-90"
            >
              ▶
            </span>
            <span className="text-[13px] font-semibold text-foreground">
              {/* A turn marker is structure, not identity and not an action, so
                  it does not spend the screen's one gold. */}
              <span aria-hidden="true" className="text-muted-foreground">
                ▍
              </span>
              {turn.turn === null ? t("runStart") : t("turn", { n: turn.turn })}
            </span>
            {turn.turn === null ? null : running ? (
              <span className="text-[11px] tracking-[0.06em] text-info">
                {t("turnRunning")}
              </span>
            ) : (
              <span className="text-[11px] tracking-[0.06em] text-success">
                {t("turnDone")}
              </span>
            )}
            <span className="ml-auto flex flex-wrap gap-1.5">
              <Chip>{t("stepCount", { count: turn.steps.length })}</Chip>
              <Chip>{t("seqSpan", { from: first.seq, to: last.seq })}</Chip>
              <Chip>{formatClock(seconds, locale)}</Chip>
              {cost === null ? null : (
                <Chip tone="cost">
                  <Money value={cost} precision="exact" />
                </Chip>
              )}
            </span>
          </div>
        </summary>
        {turn.steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            digest={stepDigest(step)}
            pos={pos}
            open={openIds.has(step.id)}
            onToggle={onToggle}
            place={place}
          />
        ))}
        {turn.reply === null ? null : <Role who="agent" text={turn.reply} />}
      </details>
    </>
  );
}

function Readout({ entries, pos }: { entries: Frames; pos: number }) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const head = entries.length - 1;
  const here = frameAt(entries, pos);
  // Elapsed and cumulative cost come from the read, not from this page: the
  // contract measures both from the run's start, so a transcript that was cut
  // short still reports what the run had spent and how far into it this frame
  // sits.
  const cost: MoneyValue | null = here.cumulativeCost;
  return (
    <span
      data-testid="transport-readout"
      className="whitespace-nowrap font-mono text-[11.5px] tabular-nums text-muted-foreground"
    >
      <b className="font-medium text-foreground">
        {t("position", { seq: here.seq })}
      </b>{" "}
      {t("of", { seq: frameAt(entries, head).seq })}
      {" · "}
      {formatClock(here.elapsedMs / 1000, locale)} /{" "}
      {formatClock(frameAt(entries, head).elapsedMs / 1000, locale)}
      {cost === null ? null : (
        <>
          {" · "}
          <b className="font-medium text-foreground">
            <Money value={cost} precision="exact" />
          </b>
        </>
      )}
    </span>
  );
}

export function TranscriptView({
  transcript,
  entries: first,
  kinds,
  zoom: initialZoom,
  status,
  org,
  ws,
  runId,
}: {
  /** `cursor` is set when entries lie past this read: more can be paged in. */
  transcript: Pick<RunTranscript, "complete" | "cursor">;
  /** The first page of the transcript's frames, at least one. */
  entries: Frames;
  /** The chips the URL pressed; a later page is read through the same filter. */
  kinds: readonly TranscriptKind[];
  /** The level the URL asked for: which disclosures start open. */
  zoom: TranscriptZoom;
  status: RunStatus;
  replayGrade: ReplayGrade | null;
} & Place) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const navigate = useNavigate();
  const place = useMemo(() => ({ org, ws, runId }), [org, ws, runId]);

  // The entries and the cursor as the last read left them. A ref as well as
  // state, because an append needs the new length before React has committed
  // the state that carries it, and this is the only place that appends.
  const heldRef = useRef<Frames>(first);
  const cursorRef = useRef<string | null>(transcript.cursor);
  const readingRef = useRef(false);
  // A signal that arrived mid-read: set when a caller finds readingRef
  // already true, so the request in flight cannot see it. The finally
  // block below checks it and runs one more tail read once that request
  // settles, so a frame landing during an active read is never dropped.
  const pendingReadRef = useRef(false);
  // Latest loadMore, so the finally block can request a follow-up without
  // closing over the useCallback identity (React Compiler refuses that).
  const loadMoreRef = useRef<() => Promise<void>>(async () => {});
  const [entries, setEntries] = useState<Frames>(first);
  const [cursor, setCursor] = useState<string | null>(transcript.cursor);
  const [complete, setComplete] = useState(transcript.complete);
  const [reading, setReading] = useState(false);
  const [pageFailure, setPageFailure] = useState<PageFailure | null>(null);
  const head = entries.length - 1;
  const turns = useMemo(() => buildTranscript(entries), [entries]);
  const live = status === "live";

  const [zoom, setZoom] = useState<TranscriptZoom>(initialZoom);
  const [openIds, setOpenIds] = useState(() => {
    const open = openAtZoom(turns, initialZoom);
    for (const id of idsAt(turns, head)) open.add(id);
    return open;
  });
  // The frame the viewer pinned; null follows the head as a live run grows.
  const [pinned, setPinned] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const bodyRef = useRef<HTMLDivElement>(null);

  const following = pinned === null;
  const pos = pinned === null ? head : Math.min(pinned, head);
  // A sealed run stops at its last frame; a live one waits there for more.
  const isPlaying = playing && (live || pos < head);

  // A viewer following a live run sees the newest step open, at any zoom but Turns.
  const shown = useMemo(() => {
    if (!following || zoom === "turns") return openIds;
    const ids = idsAt(turns, head);
    if (ids.every((id) => openIds.has(id))) return openIds;
    return new Set([...openIds, ...ids]);
  }, [following, zoom, openIds, turns, head]);

  const reveal = useCallback(
    (at: number) => {
      const ids = idsAt(turns, at);
      setOpenIds((prev) => {
        if (ids.every((id) => prev.has(id))) return prev;
        return new Set([...prev, ...ids]);
      });
    },
    [turns],
  );

  /**
   * Read the page past the cursor and append it. Nothing already on screen is
   * replaced, so the scroll position and the playhead survive the read.
   *
   * A coalesced stream signal is only "there is more to read", not a page
   * count. When a page comes back full (entry count equals the request
   * limit) and still carries a resume cursor, this drains the next page in
   * the same call so a long live replay does not stall hundreds of entries
   * behind the head until another frame lands.
   */
  const readPending = () => pendingReadRef.current;

  const loadMore = useCallback(async (): Promise<void> => {
    // A read already in flight cannot see a frame that lands while it runs,
    // so record the signal and loop below for a follow-up read once that
    // request settles, rather than dropping it or calling this function
    // recursively (which React Compiler cannot memoize safely).
    if (readingRef.current) {
      pendingReadRef.current = true;
      return;
    }
    readingRef.current = true;
    setReading(true);
    // True when the last page was full and still has a cursor: keep reading
    // in this same loadMore rather than waiting for another stream signal.
    // Declared without an initializer on purpose: every iteration clears it
    // first (a stale `true` would spin forever on empty pages), so an
    // initializer here would be written and never read.
    let drainMore: boolean;
    try {
      do {
        pendingReadRef.current = false;
        drainMore = false;
        // A sealed run stops when the page answers no cursor. A live run
        // must keep a resume cursor from the handler so SSE can ask for
        // the next page.
        if (cursorRef.current === null) return;
        const read = await readTranscriptPage(
          org,
          ws,
          runId,
          "everything",
          kinds,
          cursorRef.current,
        );
        if (!read.ok) {
          setPageFailure(read);
          return;
        }
        setPageFailure(null);
        const pageEntries = read.value.entries;
        cursorRef.current = read.value.cursor;
        setCursor(read.value.cursor);
        setComplete(read.value.complete);
        if (pageEntries.length === 0) {
          // Nothing new: stop draining. A mid-read signal still schedules
          // one follow-up via pendingReadRef / the finally block.
          continue;
        }
        const next: Frames = [...heldRef.current, ...pageEntries];
        heldRef.current = next;
        setEntries(next);
        // Full page with a resume cursor means more history is waiting.
        // Drain it now. A short page or a null cursor ends the drain.
        drainMore =
          pageEntries.length === TRANSCRIPT_ENTRY_DEFAULT &&
          cursorRef.current !== null;
        // Read through a function rather than the ref directly: the ref can
        // flip true from the early-return branch above while this `await`
        // is in flight, but TS's flow analysis cannot see that concurrent
        // write and would otherwise narrow the property to always `false`.
      } while (readPending() || drainMore);
    } catch {
      setPageFailure({
        ok: false,
        reason: "unavailable",
        code: "unanswered",
      });
    } finally {
      readingRef.current = false;
      setReading(false);
      if (pendingReadRef.current) {
        pendingReadRef.current = false;
        void loadMoreRef.current();
      }
    }
  }, [kinds, org, runId, ws]);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  // A followed live run reads its tail when the stream says a frame landed.
  const stream = useRunStream({
    url: `/api/v1/${encodeURIComponent(org)}/${encodeURIComponent(
      ws,
    )}/runs/${encodeURIComponent(runId)}/stream`,
    enabled: live && following,
    onFrames: () => {
      void loadMore();
    },
  });

  const activelyLive = live && stream !== "denied" && stream !== "lost";

  // The seal changes the header, the badges and the record actions, none of
  // which this component owns, so the page is re-read once when it happens.
  useEffect(() => {
    if (stream === "sealed") navigate.refresh();
  }, [stream, navigate]);

  // Read ahead of the playhead, so playback does not stall at a page boundary.
  useEffect(() => {
    if (!isPlaying || cursor === null || reading || stream === "denied") return;
    if (pos < head - PREFETCH_WITHIN) return;
    void loadMore();
  }, [isPlaying, pos, head, cursor, reading, loadMore, stream]);

  // Playback walks the frames at their recorded pace.
  useEffect(() => {
    if (!isPlaying || pos >= head) return;
    const timer = setTimeout(
      () => {
        const next = pos + 1;
        setPinned(next >= head ? null : next);
        reveal(next);
      },
      playDelay(entries, pos, speed),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [isPlaying, pos, head, entries, speed, reveal]);

  // Keep the marked step in view while playing; the container's scroll
  // behaviour honours reduced motion.
  useEffect(() => {
    if (!isPlaying) return;
    bodyRef.current
      ?.querySelector<HTMLElement>("[data-now]")
      ?.scrollIntoView({ block: "nearest" });
  }, [isPlaying, pos]);

  const moveTo = (next: number) => {
    const clamped = Math.max(0, Math.min(head, next));
    setPlaying(false);
    setPinned(clamped >= head ? null : clamped);
    reveal(clamped);
  };

  const toggle = useCallback((id: string, open: boolean) => {
    setOpenIds((prev) => {
      if (prev.has(id) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const chooseZoom = (level: TranscriptZoom) => {
    setZoom(level);
    const open = openAtZoom(turns, level);
    if (level !== "turns") for (const id of idsAt(turns, pos)) open.add(id);
    setOpenIds(open);
    window.history.replaceState(
      null,
      "",
      routes.run(org, ws, runId, {
        tab: "transcript",
        zoom: level,
        kinds: kindsParam(kinds),
      }),
    );
  };

  const lastTurnId = turns[turns.length - 1]?.id;

  return (
    <section
      aria-label={t("title")}
      data-testid="transcript"
      className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-2.5">
        {stream === "denied" ? null : status !== "live" ? (
          <span className="inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 font-mono text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
            {t(`recorded.${status}`)}
          </span>
        ) : following ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success/15 px-2 py-0.5 font-mono text-[10.5px] font-semibold tracking-[0.1em] text-success uppercase">
            <span
              aria-hidden="true"
              className="size-1.5 animate-pulse rounded-full bg-success"
            />
            {t("live")}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => {
              moveTo(head);
            }}
            className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted px-2 py-0.5 font-mono text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase hover:text-foreground"
          >
            {t("goLive")}
          </button>
        )}
        <button
          type="button"
          className={tpButton}
          disabled={pos <= 0}
          aria-label={t("back")}
          onClick={() => {
            moveTo(pos - 1);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="size-[13px]">
            <path d="M11.4 3.2 4.6 8l6.8 4.8Z" fill="currentColor" />
            <rect
              x="3.2"
              y="3.2"
              width="1.6"
              height="9.6"
              fill="currentColor"
            />
          </svg>
        </button>
        <button
          type="button"
          className={`${tpButton} size-[34px] border-foreground/30`}
          aria-label={isPlaying ? t("pause") : t("play")}
          onClick={() => {
            if (isPlaying) {
              setPlaying(false);
              return;
            }
            setPinned(pos >= head && !live ? 0 : pos);
            setPlaying(true);
          }}
        >
          {isPlaying ? (
            <svg viewBox="0 0 16 16" aria-hidden="true" className="size-[13px]">
              <rect
                x="4.6"
                y="3.4"
                width="2.4"
                height="9.2"
                fill="currentColor"
              />
              <rect
                x="9"
                y="3.4"
                width="2.4"
                height="9.2"
                fill="currentColor"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true" className="size-[13px]">
              <path d="M4.6 3.2 12.4 8l-7.8 4.8Z" fill="currentColor" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className={tpButton}
          disabled={pos >= head}
          aria-label={t("forward")}
          onClick={() => {
            moveTo(pos + 1);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="size-[13px]">
            <path d="M4.6 3.2 11.4 8l-6.8 4.8Z" fill="currentColor" />
            <rect
              x="11.2"
              y="3.2"
              width="1.6"
              height="9.6"
              fill="currentColor"
            />
          </svg>
        </button>
        <span className="flex min-w-[130px] flex-[1_1_190px] items-center">
          <input
            type="range"
            min={0}
            max={head}
            value={pos}
            aria-label={t("scrub")}
            aria-valuetext={t("position", { seq: frameAt(entries, pos).seq })}
            onChange={(e) => {
              moveTo(Number(e.currentTarget.value));
            }}
            className="h-1 w-full cursor-pointer accent-foreground"
          />
        </span>
        <Readout entries={entries} pos={pos} />
        <span
          role="group"
          aria-label={t("speedLabel")}
          className="flex shrink-0 overflow-hidden rounded-md border border-border"
        >
          {SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={speed === value}
              onClick={() => {
                setSpeed(value);
              }}
              className={`${segButton} font-mono`}
            >
              {t("speed", { speed: value })}
            </button>
          ))}
        </span>
        <span
          role="group"
          aria-label={t("zoomLabel")}
          className="flex shrink-0 overflow-hidden rounded-md border border-border"
        >
          {TRANSCRIPT_ZOOMS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={zoom === level}
              onClick={() => {
                chooseZoom(level);
              }}
              className={segButton}
            >
              {t(`zoom.${level}`)}
            </button>
          ))}
        </span>
        <p className="m-0 basis-full text-[11px] leading-snug text-muted-foreground">
          {t("transportNote")}
        </p>
      </div>
      <div
        ref={bodyRef}
        className="max-h-[min(66vh,760px)] overflow-y-auto motion-safe:scroll-smooth"
      >
        {turns.map((turn) => (
          <TurnBlock
            key={turn.id}
            turn={turn}
            pos={pos}
            running={activelyLive && turn.id === lastTurnId}
            openIds={shown}
            onToggle={toggle}
            place={place}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted px-3 py-2.5 text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className={`size-1.5 rounded-full ${activelyLive ? "animate-pulse bg-success" : "bg-muted-foreground"}`}
        />
        <span data-testid="transcript-count">
          {live
            ? stream === "denied"
              ? t("followDenied")
              : stream === "lost"
                ? t("followLost")
                : t("recording")
            : stream === "sealed"
              ? t("followSealed")
              : cursor !== null
                ? t("loadedMore", {
                    count: formatCount(entries.length, locale),
                  })
                : complete
                  ? t("complete", {
                      count: formatCount(entries.length, locale),
                    })
                  : t("cut", { count: formatCount(entries.length, locale) })}
        </span>
        {cursor === null ? null : (
          <button
            type="button"
            data-testid="transcript-more"
            disabled={reading || stream === "denied"}
            onClick={() => {
              void loadMore();
            }}
            className={segButton}
          >
            {reading ? t("readingMore") : t("more")}
          </button>
        )}
        {pageFailure === null ? null : (
          <span data-testid="transcript-page-failed" className="basis-full">
            {pageFailure.reason === "invalid"
              ? t("badCursor")
              : t("pageFailed")}
          </span>
        )}
      </div>
    </section>
  );
}
