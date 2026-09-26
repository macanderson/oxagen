// The Context tab (mockup `promptRow`, `runManifestPanel` and `contextTab`;
// pages/run.md, Context): what the operator wrote, what the assembler put in
// front of the agent and cut, the first request's window, the frames that
// recorded what went into context, and the retrieval figures.
//
// The record carries the operator's first prompt (the `turn_start` body),
// the input the first model call reported, the `steering.manifest` frame the
// host sealed at the session's start, and the recall frames. `get_run_context`
// adds each model request's window block by block where the call passed
// through the gateway, and the assembler's budget and counts (ADR-193). A
// block's tokens are its byte share of the provider's total, so nothing is
// counted here. A context frame's score and citation are still not recorded,
// so those cells say so.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  RunTranscript,
  TranscriptEntry,
  TranscriptRecallItem,
} from "@/data/contracts/run";
import type {
  ContextAssembly,
  ContextWindow,
  RunContext,
} from "@/data/contracts/run-context";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { buttonSecondary, eyebrowQuiet, mono } from "@/ui/control-styles";
import { type ListRow, ListTable } from "@/ui/list-table";
import { formatCount, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell } from "@/ui/table";
import {
  type FirstPrompt,
  type FirstRequest,
  firstPrompt,
  firstRequest,
  type ManifestRead,
  manifestOf,
} from "./context-model";
import { Fact, Facts, Meter, Note, NoValue, Panel, PanelBody } from "./parts";
import { FrameLink } from "./policy-tab";
import { entriesOf } from "./recorded-entries";
import { BLOCK_HUE, CompositionBar } from "./request-window";
import type { FrameTabProps, Place } from "./tab-props";
import { entryKey } from "./transcript-rows";
import { isWhole } from "./whole-transcript";

/**
 * What a manifest put in front of the model, as the server counted it from
 * the body it kept (`recall`, ADR-182): the items it rendered, the items it
 * cut and the tokens it spent. Null when the server could not read those
 * three from the manifest.
 */
function manifestTally(
  entry: TranscriptEntry,
): { rendered: number; cut: number; tokens: number } | null {
  const recall = entry.recall;
  if (
    recall === null ||
    recall.unit !== "items" ||
    recall.count === null ||
    recall.cut === null ||
    recall.tokens === null
  )
    return null;
  return { rendered: recall.count, cut: recall.cut, tokens: recall.tokens };
}

/** Where "Open the window" lands: the Prompt window panel below. */
const WINDOW_ANCHOR = "run-context-window";

/**
 * A numeric cell of the narrow context frames table: right-aligned and mono
 * like `numericCell`, but free to wrap, so "not recorded" does not push the
 * last column out of the split's detail column.
 */
const wrappingNumber = `${cell} text-right font-mono tabular-nums`;

/** How many cut items the spine shows before it folds the rest. */
const CUTS_SHOWN = 3;

/**
 * `.pr-bar { grid-template-columns:minmax(0,22ch) 1fr auto; gap:9px;
 * font-size:11.5px; color:var(--muted) }`, its `.t` track (7px on the wash)
 * and its `.v` figure (mono 10.5px): one part of the first request.
 */
const promptBar =
  "grid grid-cols-[minmax(0,22ch)_1fr_auto] items-center gap-[9px] text-[11.5px] text-muted-foreground";

/**
 * `.ro-dot { position:absolute; left:-30px; top:6px; width:23px; height:23px;
 * border-radius:50%; border:1px solid var(--border) }`, dashed and dim on a
 * cut item (`.stg-mf .ro-n.s-withheld .ro-dot`).
 */
const spineDot =
  "absolute -left-[30px] top-1.5 grid size-[23px] place-items-center rounded-full border border-border bg-card";

/**
 * `.ctxi { display:flex; gap:9px; padding:7px 9px; border-radius:8px;
 * font-size:12.5px; color:var(--muted) }`, the wash on hover, and its `.sw`
 * swatch (8px, radius 2px) and `.tk` figure (mono 10.5px, dim).
 */
const windowItem =
  "flex w-full items-center gap-[9px] rounded-lg px-[9px] py-[7px] text-left text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-hl hover:text-foreground";

/** The kind's glyph on the spine: a gate for a policy, a page for a skill, a mark for the rest. */
function ItemGlyph({ kind }: { kind: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-[13px]"
    >
      {kind === "policy" ? (
        <>
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </>
      ) : kind === "skill" ? (
        <>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
        </>
      ) : kind === "steer" ? (
        <path d="M4 5h16v10H9l-5 4z" />
      ) : (
        <path d="M6 3h12v18l-6-4-6 4z" />
      )}
    </svg>
  );
}

/** Who wrote the prompt: the run's operator, by name where the record holds one. */
function operatorOf(run: RunRow): string | null {
  return run.operatorName ?? run.operatorId;
}

/**
 * The first request's blocks as bars, each track filled by its share of the
 * window and its tokens beside it (bytes when the provider reported no
 * input). The shares are the ones `get_run_context` split the total by.
 */
function WindowBars({ measured }: { measured: ContextWindow }) {
  const t = useTranslations("run.frames.window");
  const locale = useLocale();
  const size = (block: ContextWindow["blocks"][number]) =>
    block.tokens ?? block.bytes;
  const whole = measured.blocks.reduce((sum, block) => sum + size(block), 0);
  return (
    <div className="grid gap-1.5" data-testid="run-context-bars">
      {measured.blocks.map((block) => (
        <div
          key={block.kind}
          data-testid="run-context-bar"
          data-kind={block.kind}
          className={promptBar}
        >
          <span className="truncate">{t(`block.${block.kind}`)}</span>
          <span className="block h-[7px] min-w-0 overflow-hidden rounded-[4px] bg-hl">
            <i
              aria-hidden="true"
              className={`block h-full rounded-[4px] ${BLOCK_HUE[block.kind]}`}
              style={{
                width: `${String(whole === 0 ? 0 : (size(block) / whole) * 100)}%`,
              }}
            />
          </span>
          <span className="font-mono text-[10.5px]">
            {block.tokens === null
              ? t("bytes", { count: formatCount(block.bytes, locale) })
              : t("tokens", { count: formatCount(block.tokens, locale) })}
          </span>
        </div>
      ))}
    </div>
  );
}

function PromptPanel({
  run,
  prompt,
  request,
  measured,
}: {
  run: RunRow;
  prompt: FirstPrompt | null;
  request: FirstRequest | null;
  /** The first request's window; null when the record measured none. */
  measured: ContextWindow | null;
}) {
  const t = useTranslations("run.context.prompt");
  const locale = useLocale();
  const operator = operatorOf(run);
  const parts = [t("words"), t("toolsSteering"), t("systemBrief")];
  // The window's total is the provider's, the same figure the bars split, so
  // "tok sent" and the window cannot disagree.
  const sent = measured?.promptTokens ?? request?.input ?? null;
  return (
    <Panel
      title={t("title")}
      testId="run-context-prompt"
      aside={
        <>
          <span className="font-mono text-[11px] text-dim">
            {t("writtenNotRecorded")} ·{" "}
            {sent === null
              ? t("sentNotRecorded")
              : t("sent", { count: formatCount(sent, locale) })}
          </span>
          {/* A fragment on this page: WINDOW_ANCHOR, written out because a link's target is never computed (INV-13). */}
          <a
            href="#run-context-window"
            className={`${buttonSecondary} min-h-7 px-2.5 text-xs`}
          >
            {t("openWindow")}
          </a>
        </>
      }
    >
      <div className="grid gap-[18px] md:grid-cols-2">
        <div className="min-w-0">
          <p className={`${eyebrowQuiet} mb-1.5`}>
            {operator === null
              ? t("writtenByUnknown")
              : t("writtenBy", { name: operator })}
          </p>
          <p
            data-testid="run-context-first-prompt"
            className="m-0 max-w-[52ch] text-[14.5px] leading-[1.55] text-foreground [overflow-wrap:anywhere]"
          >
            {prompt === null
              ? t("noPrompt")
              : prompt.text === null
                ? t("textNotRetained")
                : t("quote", { text: prompt.text })}
          </p>
        </div>
        <div className="min-w-0">
          <p className={`${eyebrowQuiet} mb-1.5`}>{t("firstRequest")}</p>
          {request === null && measured === null ? (
            <p className="m-0 text-[11.5px] text-muted-foreground">
              {t("noRequest")}
            </p>
          ) : (
            <>
              {measured === null ? (
                <div className="grid gap-1.5" data-testid="run-context-bars">
                  {parts.map((part) => (
                    <div key={part} className={promptBar}>
                      <span className="truncate">{part}</span>
                      <span className="block h-[7px] min-w-0 overflow-hidden rounded-[4px] bg-hl" />
                      <span className="font-mono text-[10.5px]">
                        <NoValue />
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <WindowBars measured={measured} />
              )}
              <p className="mb-0 mt-2 text-[11.5px] text-muted-foreground">
                {request !== null &&
                request.input !== null &&
                request.cached !== null
                  ? t("cache", {
                      total: formatCount(sent ?? request.input, locale),
                      cached: formatCount(request.cached, locale),
                    })
                  : request !== null && request.cached !== null
                    ? t("cachedOnly", {
                        cached: formatCount(request.cached, locale),
                      })
                    : t("noUsage")}{" "}
                {measured === null ? t("splitNotRecorded") : t("splitByBytes")}
              </p>
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** One item of the manifest, as the spine draws it from the server's reading. */
function SpineNode({ item }: { item: TranscriptRecallItem }) {
  const t = useTranslations("run.context.manifest");
  const locale = useLocale();
  const cut = item.outcome === "cut";
  const why = !cut
    ? null
    : item.supersededBy !== null
      ? t("why.superseded", { id: item.supersededBy })
      : item.reason === "budget"
        ? t("why.budget")
        : item.reason === "tier"
          ? t("why.tier")
          : null;
  return (
    <li
      data-testid="run-manifest-item"
      data-outcome={item.outcome}
      className="relative min-w-0 py-[7px]"
    >
      <span
        className={`${spineDot} ${cut ? "border-dashed text-dim" : "text-muted-foreground"}`}
      >
        <ItemGlyph kind={item.kind} />
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className={`${mono} min-w-0 break-all text-[12.5px] ${cut ? "text-muted-foreground" : "font-semibold text-foreground"}`}
          >
            {item.label}
          </span>
          {cut ? (
            <Badge tone="quiet" dot={false}>
              {t("cutState", { reason: item.reason ?? t("noReason") })}
            </Badge>
          ) : (
            <Badge tone="allowed">{t("rendered")}</Badge>
          )}
          <Badge tone="quiet" dot={false}>
            {item.kind}
          </Badge>
          {item.force === null ? null : (
            <Badge tone="quiet" dot={false}>
              {item.force}
            </Badge>
          )}
          {item.tokens === null ? null : (
            <Badge tone="quiet" dot={false} mono>
              {t("tokens", { count: formatCount(item.tokens, locale) })}
            </Badge>
          )}
        </div>
        {why === null ? null : (
          <p className="mb-0 mt-[3px] text-[11.5px] leading-[1.5] text-muted-foreground">
            {why}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * `.ro.stg-mf`: the manifest frame as a spine, the rendered items first in
 * the assembler's rank order and the cuts after them, dashed, three shown and
 * the rest folded.
 */
function ManifestSpine({
  manifest,
  run,
}: {
  manifest: ManifestRead | null;
  run: RunRow;
}) {
  const t = useTranslations("run.context.manifest");
  const locale = useLocale();
  const read = manifest?.state === "read" ? manifest.recall : null;
  const tally = manifest === null ? null : manifestTally(manifest.entry);
  const rendered =
    read?.items.filter((item) => item.outcome === "included") ?? [];
  const cuts = read?.items.filter((item) => item.outcome === "cut") ?? [];
  return (
    <section
      aria-label={t("label")}
      data-testid="run-manifest"
      className="rounded-xl border border-border bg-card px-[18px] pb-[13px] pt-[15px] text-card-foreground"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <h3 className={`${eyebrowQuiet} m-0`}>{t("title")}</h3>
        {tally === null ? null : (
          <span
            data-testid="run-manifest-tally"
            className="ml-auto font-mono text-[11px] text-dim"
          >
            {t("renderedCount", { count: formatCount(tally.rendered, locale) })}{" "}
            · {t("cutCount", { count: formatCount(tally.cut, locale) })} ·{" "}
            {t("tokens", { count: formatCount(tally.tokens, locale) })}
          </span>
        )}
        {/*
          `.ro-link`. Steering has no Preview tab yet, so the button says so
          on itself rather than opening a page that is not there.
        */}
        <span id="run-manifest-preview-why" className="sr-only">
          {t("previewMissing")}
        </span>
        <button
          type="button"
          disabled
          title={t("previewMissing")}
          aria-describedby="run-manifest-preview-why"
          className={`${tally === null ? "ml-auto" : ""} cursor-not-allowed text-[11.5px] text-muted-foreground underline decoration-rule underline-offset-2 opacity-70`}
        >
          {t("preview")}
        </button>
      </div>
      {manifest !== null && run.enforcementTier === "observe" ? (
        <p
          data-testid="run-manifest-observe"
          className="mb-2.5 rounded-[10px] border border-critical/45 bg-critical/10 px-3.5 py-[11px] text-[12.5px] text-foreground"
        >
          <b className="text-critical">{t("observeTitle")}</b> {t("observe")}
        </p>
      ) : null}
      {manifest === null ? (
        <p className="m-0 text-[12.5px] text-muted-foreground">{t("none")}</p>
      ) : read === null ? (
        <p className="m-0 text-[12.5px] text-muted-foreground">
          {t(`unread.${manifest.state === "read" ? "failed" : manifest.state}`)}
        </p>
      ) : (
        // `.ro-spine { padding-left:30px }` and its rule, 1px at 11px in.
        <ol className="relative m-0 list-none pl-[30px] before:absolute before:bottom-1.5 before:left-[11px] before:top-1.5 before:w-px before:bg-rule">
          {rendered.map((item, index) => (
            <SpineNode key={`in:${item.label}:${String(index)}`} item={item} />
          ))}
          {cuts.slice(0, CUTS_SHOWN).map((item, index) => (
            <SpineNode key={`cut:${item.label}:${String(index)}`} item={item} />
          ))}
          {cuts.length > CUTS_SHOWN ? (
            <li className="relative py-[5px]">
              <details className="group">
                <summary className="cursor-pointer list-none text-[11.5px] text-muted-foreground underline decoration-rule underline-offset-2 hover:text-foreground [&::-webkit-details-marker]:hidden">
                  {t("moreCut", {
                    count: formatCount(cuts.length - CUTS_SHOWN, locale),
                  })}
                </summary>
                <ol className="m-0 list-none p-0">
                  {cuts.slice(CUTS_SHOWN).map((item, index) => (
                    <SpineNode
                      key={`cut:${item.label}:${String(index + CUTS_SHOWN)}`}
                      item={item}
                    />
                  ))}
                </ol>
              </details>
            </li>
          ) : null}
        </ol>
      )}
      {manifest === null ? null : (
        <p className="mb-0 mt-[11px] border-t border-border pt-2.5 text-[11px] text-dim">
          {read === null || read.bundleVersion === null
            ? t("footNoBundle", { seq: manifest.entry.seq })
            : t("foot", {
                seq: manifest.entry.seq,
                version: String(read.bundleVersion),
              })}
        </p>
      )}
    </section>
  );
}

/**
 * The first request's window: its blocks as the composition bar where the
 * record measured them (ADR-193), else its reported total and the split the
 * record does not carry.
 */
function PromptWindow({
  request,
  context,
  runId,
}: {
  request: FirstRequest | null;
  /** `get_run_context`; the first window it lists is the first request's. */
  context: Read<RunContext>;
  runId: string;
}) {
  const t = useTranslations("run.context.window");
  const locale = useLocale();
  const measured = context.ok ? (context.value.windows[0] ?? null) : null;
  if (measured !== null)
    return (
      <div id={WINDOW_ANCHOR}>
        <Panel
          title={t("title")}
          testId="run-context-window"
          aside={
            <>
              <Badge tone="quiet" dot={false} mono>
                {t("frame", { seq: measured.seq })}
              </Badge>
              <Badge tone="quiet" dot={false}>
                {measured.promptTokens === null
                  ? t("inputNotRecorded")
                  : t("input", {
                      count: formatCount(measured.promptTokens, locale),
                    })}
              </Badge>
            </>
          }
        >
          <CompositionBar recorded={measured} />
          <div className="mt-[13px]">
            <Note testId="run-context-window-note">
              {measured.promptTokens === null
                ? t("measuredBytes")
                : t("measured")}
            </Note>
          </div>
        </Panel>
      </div>
    );
  if (request === null)
    return (
      <div id={WINDOW_ANCHOR}>
        <section
          data-testid="run-context-no-window"
          aria-label={t("noneTitle")}
          className="rounded-xl border border-border bg-card px-[18px] py-4 text-card-foreground"
        >
          <p className={`${eyebrowQuiet} mb-1.5`}>{t("noneTitle")}</p>
          <p className="m-0 text-[13px]">{t("none", { run: runId })}</p>
        </section>
      </div>
    );
  return (
    <div id={WINDOW_ANCHOR}>
      <Panel
        title={t("title")}
        testId="run-context-window"
        aside={
          <>
            <Badge tone="quiet" dot={false} mono>
              {t("request", {
                type: request.type,
                seq: request.seq,
              })}
            </Badge>
            <Badge tone="quiet" dot={false}>
              {request.input === null
                ? t("inputNotRecorded")
                : t("input", { count: formatCount(request.input, locale) })}
            </Badge>
          </>
        }
      >
        {/* `.compbar { height:30px; border-radius:9px; border:1px solid var(--border); background:var(--hl) }`, with no band the record can fill. */}
        <div className="flex h-[30px] items-center justify-center rounded-[9px] border border-border bg-hl font-mono text-[10.5px] text-dim">
          {t("blocksNotRecorded")}
        </div>
        <div className="mt-[13px]">
          <Note>{t("note")}</Note>
        </div>
        {context.ok ? null : (
          <div className="mt-2">
            <ReadFailure read={context} section={t("title")} />
          </div>
        )}
      </Panel>
    </div>
  );
}

/** A cell the record does not carry yet, with the gap on hover. */
function Unrecorded() {
  const t = useTranslations("run.context.frames");
  return (
    <span title={t("unrecorded")} className="font-sans text-[12px]">
      <NoValue />
    </span>
  );
}

function frameRow(
  entry: TranscriptEntry,
  manifest: ManifestRead | null,
  place: Place,
  tokens: (count: number) => string,
): ListRow {
  const counted =
    manifest !== null && manifest.entry === entry
      ? (manifestTally(entry)?.tokens ?? null)
      : null;
  return {
    key: entryKey(entry),
    data: { "data-testid": "run-context-frame" },
    cells: [
      <Badge key="kind" tone="quiet" dot={false} mono>
        {entry.type}
      </Badge>,
      <span key="frame" className="flex min-w-0 flex-wrap items-baseline gap-2">
        <FrameLink
          seq={entry.seq}
          chainRef={entry.subagent?.chainRef}
          place={place}
        />
        {/* A label that only repeats the kind says nothing the Kind column does not. */}
        {entry.label === entry.type ? null : (
          <span className={`${mono} text-[11.5px] text-foreground`}>
            {entry.label}
          </span>
        )}
      </span>,
      counted === null ? <Unrecorded key="tok" /> : tokens(counted),
      <Unrecorded key="score" />,
      <Unrecorded key="cited" />,
    ],
  };
}

/** `context.frames`: every frame that recorded what went into the model's context. */
function ContextFrames({
  read,
  manifest,
  place,
}: {
  read: Read<RunTranscript>;
  manifest: ManifestRead | null;
  place: Place;
}) {
  const t = useTranslations("run.context.frames");
  const locale = useLocale();
  const entries = entriesOf(read, "recall");
  if (entries === null || !read.ok)
    return (
      <Panel title={t("title")} testId="run-context-frames">
        {read.ok ? null : <ReadFailure read={read} section={t("title")} />}
      </Panel>
    );
  return (
    <Panel
      title={t("title")}
      testId="run-context-frames"
      flush
      aside={
        <Badge tone="quiet" dot={false}>
          {formatCount(entries.length, locale)}
        </Badge>
      }
    >
      {entries.length === 0 ? (
        <PanelBody>
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </PanelBody>
      ) : (
        // `table.narrow`: the split's detail column is narrower than a list
        // table's minimum, so the columns wrap rather than scroll.
        <div className="[&_table]:min-w-0">
          <ListTable
            label={t("title")}
            columns={[
              { label: t("kind") },
              { label: t("frame") },
              { label: t("tok"), numeric: true, className: wrappingNumber },
              { label: t("score"), numeric: true, className: wrappingNumber },
              { label: t("cited") },
            ]}
            rows={entries.map((entry) =>
              frameRow(entry, manifest, place, (count) =>
                formatCount(count, locale),
              ),
            )}
          />
        </div>
      )}
      <PanelBody rule={entries.length > 0}>
        <div className="flex flex-col gap-2">
          <Note>{t("note")}</Note>
          {isWhole(read.value) ? null : (
            <p className="text-xs text-muted-foreground">{t("cut")}</p>
          )}
        </div>
      </PanelBody>
    </Panel>
  );
}

/** One stop on the walk: a swatch in the frame kind's hue, the frame, and what it counted. */
type Stop = {
  entry: TranscriptEntry;
  /** A frame-kind hue class (engine.css `.fk-*`). */
  hue: string;
  figure: string | null;
};

/** The frames that fed the window, in the order they were recorded, each opening its frame. */
function WalkWindow({
  stops,
  place,
}: {
  stops: readonly Stop[];
  place: Place;
}) {
  const t = useTranslations("run.context.walk");
  return (
    <Panel title={t("title")} testId="run-context-walk" flush>
      {stops.length === 0 ? (
        <PanelBody>
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </PanelBody>
      ) : (
        // `.stack { padding:7px; max-height:560px; overflow-y:auto }`
        <ol className="m-0 max-h-[560px] list-none overflow-y-auto p-[7px]">
          {stops.map((stop) => (
            <li key={entryKey(stop.entry)}>
              <SafeLink
                to={routes.run(place.org, place.ws, place.runId, {
                  tab: "actions",
                  body: stop.entry.seq,
                })}
                className={windowItem}
              >
                <span
                  aria-hidden="true"
                  className={`size-2 flex-none rounded-[2px] ${stop.hue}`}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                  {t("stop", { type: stop.entry.type, seq: stop.entry.seq })}
                </span>
                <span className="flex-none font-mono text-[10.5px] tabular-nums text-dim">
                  {stop.figure ?? t("frame", { seq: stop.entry.seq })}
                </span>
              </SafeLink>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/**
 * The assembler's figures from the first manifest `get_run_context` read
 * (ADR-193): what it spent of its budget, the candidates it ranked, kept and
 * cut, the headroom left and the digest of the text. The assembler has no
 * relevance floor, so that figure stays not recorded.
 */
function RetrievalStats({
  assembled,
  assembly,
  place,
}: {
  assembled: TranscriptEntry | null;
  assembly: ContextAssembly | null;
  place: Place;
}) {
  const t = useTranslations("run.context.retrieval");
  const locale = useLocale();
  const count = (value: number) => formatCount(value, locale);
  const share =
    assembly === null || assembly.budgetTokens === 0
      ? null
      : assembly.spentTokens / assembly.budgetTokens;
  return (
    <Panel title={t("title")} testId="run-context-retrieval">
      <Meter
        label={t("budget")}
        value={
          assembly === null ? (
            <NoValue />
          ) : (
            t("spent", {
              spent: count(assembly.spentTokens),
              budget: count(assembly.budgetTokens),
            })
          )
        }
        share={share}
        hue="bg-proven"
        title={share === null ? undefined : formatRatio(share, locale)}
      />
      <div className="mt-[13px]">
        <Facts>
          <Fact label={t("scored")}>
            {assembly === null ? (
              <NoValue />
            ) : (
              count(assembly.included + assembly.cut)
            )}
          </Fact>
          <Fact label={t("admitted")}>
            {assembly === null ? <NoValue /> : count(assembly.included)}
          </Fact>
          <Fact label={t("held")}>
            {assembly === null ? <NoValue /> : count(assembly.cut)}
          </Fact>
          <Fact label={t("floor")}>
            <NoValue />
          </Fact>
          <Fact label={t("headroom")}>
            {assembly === null ? (
              <NoValue />
            ) : (
              t("tokens", {
                count: count(
                  Math.max(0, assembly.budgetTokens - assembly.spentTokens),
                ),
              })
            )}
          </Fact>
          <Fact label={t("digest")} code={assembly !== null && assembly.textDigest !== null}>
            {assembly?.textDigest ?? <NoValue />}
          </Fact>
          {assembled === null ? null : (
            <Fact label={t("assembledAt")}>
              <FrameLink
                seq={assembled.seq}
                chainRef={undefined}
                place={place}
                label={t("assembledFrame", {
                  type: assembled.type,
                  seq: assembled.seq,
                })}
              />
            </Fact>
          )}
        </Facts>
      </div>
      <div className="mt-3">
        <Note>{assembly === null ? t("note") : t("recorded")}</Note>
      </div>
    </Panel>
  );
}

function ContextBody({
  run,
  read,
  steps,
  manifest,
  context,
  place,
}: {
  run: RunRow;
  /** The run at `everything`: the frames the tab lists. */
  read: Read<RunTranscript>;
  /** The run at `steps`, where the first model step is one entry. */
  steps: Read<RunTranscript>;
  manifest: ManifestRead | null;
  /** `get_run_context`: the windows and the assembler's manifests. */
  context: Read<RunContext>;
  place: Place;
}) {
  const t = useTranslations("run.context");
  const locale = useLocale();
  if (!read.ok)
    return (
      <Panel title={t("prompt.title")} testId="run-context-prompt">
        <ReadFailure read={read} section={t("prompt.title")} />
      </Panel>
    );
  const entries = read.value.entries;
  const prompt = firstPrompt(entries);
  const request = steps.ok ? firstRequest(steps.value.entries) : null;
  const recalls = entriesOf(read, "recall") ?? [];
  const assembled =
    recalls.find(
      (entry) =>
        entry.type === "context.assembled" && entry.subagent === undefined,
    ) ?? null;
  const stopOf = (entry: TranscriptEntry): Stop | null => {
    if (entry.subagent !== undefined) return null;
    if (manifest !== null && entry === manifest.entry) {
      const tally = manifestTally(entry);
      return {
        entry,
        hue: "bg-kind-rule",
        figure:
          tally === null
            ? null
            : t("walk.tokens", { count: formatCount(tally.tokens, locale) }),
      };
    }
    if (entry.kinds.includes("recall"))
      return { entry, hue: "bg-fk-ctx", figure: null };
    if (
      prompt !== null &&
      entry.seq === prompt.seq &&
      entry.type === "turn_start"
    )
      return { entry, hue: "bg-fk-op", figure: null };
    // The first model step opens on this frame (a subagent's frames were
    // passed over above).
    if (
      request !== null &&
      entry.seq === request.seq &&
      entry.type === request.type
    )
      return {
        entry,
        hue: "bg-fk-model",
        figure:
          request.input === null
            ? null
            : t("walk.tokens", { count: formatCount(request.input, locale) }),
      };
    return null;
  };
  const stops = entries.flatMap((entry) => {
    const stop = stopOf(entry);
    return stop === null ? [] : [stop];
  });
  const measured = context.ok ? (context.value.windows[0] ?? null) : null;
  const assembly = context.ok ? (context.value.assemblies[0] ?? null) : null;
  return (
    <>
      <PromptPanel
        run={run}
        prompt={prompt}
        request={request}
        measured={measured}
      />
      <ManifestSpine manifest={manifest} run={run} />
      <PromptWindow request={request} context={context} runId={run.id} />
      {/* `.split { grid-template-columns:minmax(0,1fr) 340px }`, one column under 1080px. */}
      <div className="grid items-start gap-3.5 min-[67.5rem]:grid-cols-[minmax(0,1fr)_340px]">
        <ContextFrames read={read} manifest={manifest} place={place} />
        <div className="flex min-w-0 flex-col gap-3.5">
          <WalkWindow stops={stops} place={place} />
          <RetrievalStats
            assembled={assembled}
            assembly={assembly}
            place={place}
          />
        </div>
      </div>
    </>
  );
}

/**
 * The Context tab. Its one read of its own is `get_run_context`, the windows
 * and the assembler's figures (ADR-193). The manifest's items come from the
 * transcript: the server read the frame's whole body and states each item's
 * outcome on the entry (`recall`, ADR-182).
 */
export async function ContextTab(props: FrameTabProps): Promise<ReactNode> {
  const { ctx, source, everything, transcript, run, place } = props;
  const manifest = everything.ok ? manifestOf(everything.value.entries) : null;
  const context = await source.runs.context(ctx, run.id);
  return (
    <ContextBody
      run={run}
      read={everything}
      steps={transcript}
      manifest={manifest}
      context={context}
      place={place}
    />
  );
}
