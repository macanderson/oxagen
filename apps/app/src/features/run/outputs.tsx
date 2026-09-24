// The Run page's spine (mockup `RunOutputs`): what the run produced, in the
// order it produced it. It sits under the header and above the tabs, because
// the first question anyone brings to a run is what came of it, and an answer
// behind a tab is an answer nobody reads.
//
// One node per thing produced: the kind's glyph, the name in mono, where it
// landed, the recorded disposition as a badge, a diff stat where the recorder
// counted lines, and the frame that produced it. A stretch of reads collapses
// into one hairline tick that names the paths the run looked at, so a change
// and a look can never read alike.
//
// Three things here are recorded and not inferred, which is what keeps the
// page from overstating a run: the badge carries the store's own word, a
// ledger change names the locator the ledger recorded and says the ledger
// keeps no path, and a gate sits at the end of the spine, which is where it
// stopped the run. Nothing after a gate happened.
//
// Everything a person can toggle is a query value, the rule the tabs already
// follow (ARCHITECTURE.md §1.2): `?reads=hide` folds the read marks away and
// `?spine=2,5` opens folded groups. A server render then needs no client
// state, and a link to this view opens it as the sender left it.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  RunOutputKind,
  RunOutputNode,
  RunOutputs,
} from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import { buttonSecondary, eyebrowQuiet, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";

/** More than this many nodes of one kind in a row fold to a count. */
const FOLD_OVER = 3;
/** How many stay in view when a group folds. */
const FOLD_KEEP = 2;
/** Names a read mark prints before it counts the rest. */
const READ_NAMES = 2;

/**
 * The badge hue per state (mockup `RO_STATE`). Gold is identity and never a
 * state, so nothing here is gold: a parked gate takes the approval hue and a
 * refusal takes the denial hue.
 */
const TONE: Record<RunOutputNode["state"], BadgeTone> = {
  created: "allowed",
  written: "allowed",
  pushed: "allowed",
  open: "allowed",
  deleted: "quiet",
  renamed: "quiet",
  read: "quiet",
  withheld: "quiet",
  awaiting: "approval",
  blocked: "denied",
};

/** The kind's glyph (mockup `RO_ICON`), drawn on a 24 unit grid. */
const GLYPH: Record<RunOutputKind, ReactNode> = {
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  media: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 16-5-5-6 6-3-3-4 4" />
    </>
  ),
  change: <path d="M6 3h12v18l-6-4-6 4z" />,
  commit: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M18 10.5c0 4-3.5 4-6 5.5" />
    </>
  ),
  pr: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7M18 15.5V10a3 3 0 0 0-3-3h-4" />
      <path d="m13 4-2 3 2 3" />
    </>
  ),
  gate: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  would: (
    <>
      <path d="M4 12h10" />
      <path d="m13 7 5 5-5 5" />
    </>
  ),
  read: (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
};

function Glyph({ kind }: { kind: RunOutputKind }) {
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
      {GLYPH[kind]}
    </svg>
  );
}

type Place = { org: string; ws: string; runId: string };

/** The two query values, so a link can keep the one it is not changing. */
type View = { reads: boolean; open: ReadonlySet<number> };

/** One run of adjacent nodes of the same kind, as the fold rule groups them. */
type OutputGroup = {
  kind: RunOutputKind;
  items: RunOutputNode[];
  index: number;
};

function groupNodes(nodes: readonly RunOutputNode[]): OutputGroup[] {
  const groups: OutputGroup[] = [];
  for (const node of nodes) {
    const last = groups.at(-1);
    if (last !== undefined && last.kind === node.kind) last.items.push(node);
    else groups.push({ kind: node.kind, items: [node], index: groups.length });
  }
  return groups;
}

/** `?spine=1,4`: the groups a person opened. A word that is not an index opens none. */
function parseOpen(raw: string | null): Set<number> {
  const open = new Set<number>();
  if (raw === null) return open;
  for (const part of raw.split(",")) {
    if (/^\d{1,4}$/.test(part)) open.add(Number(part));
  }
  return open;
}

function spineParam(open: ReadonlySet<number>): string | undefined {
  return open.size === 0
    ? undefined
    : [...open].sort((a, b) => a - b).join(",");
}

/** The same view with one group's fold flipped, so the other folds survive the click. */
function withToggled(open: ReadonlySet<number>, index: number): Set<number> {
  const next = new Set(open);
  if (!next.delete(index)) next.add(index);
  return next;
}

function href(place: Place, view: View) {
  return routes.run(place.org, place.ws, place.runId, {
    reads: view.reads ? undefined : "hide",
    spine: spineParam(view.open),
  });
}

/**
 * `.ro-link { font-size:11.5px; color:var(--muted); text-decoration:underline;
 * text-underline-offset:2px; text-decoration-color:var(--rule) }`.
 */
const linkQuiet =
  "rounded-sm text-[11.5px] text-muted-foreground underline decoration-rule underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * `.ro-dot { position:absolute; left:-30px; top:6px; width:23px; height:23px;
 * border-radius:50%; border:1px solid var(--border); background:var(--panel) }`,
 * tinted by the node's state (`.ro-n.s-awaiting .ro-dot`, `.s-blocked`) and
 * dashed for a held call (`.ro-would .ro-dot`).
 */
const DOT_TONE: Partial<Record<RunOutputNode["state"], string>> = {
  awaiting: "border-info/55 text-info",
  blocked: "border-warning/55 text-warning",
};

/** `.ro-tick { position:absolute; left:-23px; top:12px; width:9px; height:1px; background:var(--rule) }` */
const tick = "absolute -left-[23px] top-3 h-px w-[9px] bg-rule";

/** `fr 118`: the frame that recorded the node, which opens the Frames tab on it. */
function Frame({ seq, place }: { seq: string | null; place: Place }) {
  const t = useTranslations("run.outputs");
  if (seq === null) return null;
  return (
    <SafeLink
      to={routes.run(place.org, place.ws, place.runId, {
        tab: "actions",
        body: seq,
      })}
      title={t("frameTitle")}
      className="shrink-0 rounded-md border border-border bg-background px-1.5 py-px font-mono text-[10.5px] text-dim hover:border-rule hover:text-foreground"
    >
      {t("frame", { seq })}
    </SafeLink>
  );
}

/** The lines the recorder counted. A read never carries one, by the handler's rule. */
function Stat({ stat }: { stat: RunOutputNode["stat"] }) {
  if (stat === null) return null;
  return (
    <span className={`${mono} shrink-0 text-[11px] tabular-nums`}>
      <b className="font-semibold text-success">+{stat.added}</b>{" "}
      <b className="font-semibold text-warning">&minus;{stat.removed}</b>
    </span>
  );
}

/**
 * React keys that stay unique when two items share a label: the label plus
 * how many times it appeared before. A key on the label alone merges the
 * repeats; a key on the array index is what the lint rule refuses.
 */
function keyedByOccurrence<T>(
  items: readonly T[],
  label: (item: T) => string,
): { item: T; key: string }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = label(item);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { item, key: `${base}#${String(n)}` };
  });
}

function Node({ node, place }: { node: RunOutputNode; place: Place }) {
  const t = useTranslations("run.outputs");
  const would = node.kind === "would";
  const gate = node.kind === "gate";
  return (
    <li
      data-kind={node.kind}
      data-state={node.state}
      className="relative min-w-0 py-[7px]"
    >
      <span
        aria-hidden="true"
        className={`absolute -left-[30px] top-1.5 grid size-[23px] place-items-center rounded-full border bg-card ${
          would
            ? "border-dashed border-border text-dim"
            : (DOT_TONE[node.state] ?? "border-border text-muted-foreground")
        }`}
      >
        <Glyph kind={node.kind} />
      </span>
      <div
        className={`min-w-0 ${
          gate
            ? "rounded-[10px] border border-info/40 bg-info/10 px-3 py-2.5"
            : would
              ? "rounded-[10px] border border-dashed border-rule px-3 py-2"
              : ""
        }`}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <b
            className={`min-w-0 max-w-full truncate text-[13px] ${
              would
                ? "font-medium text-muted-foreground"
                : "font-mono font-semibold text-foreground"
            }`}
          >
            {node.name}
          </b>
          <Badge tone={TONE[node.state]}>{t(`state.${node.state}`)}</Badge>
          <Stat stat={node.stat} />
          <Frame seq={node.seq} place={place} />
        </div>
        <div className="mt-[3px] flex flex-wrap items-baseline gap-2 text-[11.5px] leading-normal">
          {node.where === null ? null : (
            <span className="font-mono text-[11px] text-dim">{node.where}</span>
          )}
          {node.note === null ? null : (
            <span className="min-w-0 text-muted-foreground">{node.note}</span>
          )}
          {/* The ledger records a change without its path. Saying so beats
              printing `rpl_…` where a reader expects a file name. */}
          {node.nameIsLocator ? (
            <span className="text-muted-foreground">{t("locator")}</span>
          ) : null}
        </div>
        {gate ? (
          <div className="mt-[9px] flex flex-wrap items-center gap-2.5">
            <SafeLink
              to={routes.run(place.org, place.ws, place.runId, {
                tab: "actions",
              })}
              className={`${buttonSecondary} min-h-7 px-2.5 text-xs`}
            >
              {t("reviewApproval")}
            </SafeLink>
            <span className="text-[11px] text-muted-foreground">
              {t("gateHint")}
            </span>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** The hairline tick a stretch of reads folds into: the run looked, it changed nothing. */
function ReadMark({
  group,
  view,
  place,
}: {
  group: OutputGroup;
  view: View;
  place: Place;
}) {
  const t = useTranslations("run.outputs");
  const opened = view.open.has(group.index);
  const names = group.items.map((node) => node.name);
  const shown = opened ? names : names.slice(0, READ_NAMES);
  const rest = names.length - shown.length;
  const fold = href(place, {
    reads: view.reads,
    open: withToggled(view.open, group.index),
  });
  const notes = group.items
    .map((node) => node.note)
    .filter((note): note is string => note !== null);
  return (
    <li
      data-kind="read"
      className="relative flex min-w-0 flex-wrap items-baseline gap-2 py-[5px]"
    >
      <span aria-hidden="true" className={tick} />
      <span className="min-w-0 text-[11.5px] text-dim">
        {t("readMark")}{" "}
        {keyedByOccurrence(shown, (name) => name).map(
          ({ item: name, key }, i) => (
            // Two reads of one path are two reads, so the key carries how
            // many times the name appeared before it.
            <span key={key}>
              {i === 0 ? null : ", "}
              <b className="break-all font-mono text-[11px] font-medium text-muted-foreground">
                {name}
              </b>
            </span>
          ),
        )}
        {rest > 0 ? (
          <>
            {" "}
            <SafeLink to={fold} className={linkQuiet}>
              {t("andMore", { count: rest })}
            </SafeLink>
          </>
        ) : null}
        {opened && names.length > READ_NAMES ? (
          <>
            {" "}
            <SafeLink to={fold} className={linkQuiet}>
              {t("foldBack")}
            </SafeLink>
          </>
        ) : null}
        {notes.length === 0 ? null : (
          <span className="text-dim"> · {notes.join(" · ")}</span>
        )}
      </span>
      <Frame seq={group.items.at(-1)?.seq ?? null} place={place} />
    </li>
  );
}

/** A run that wrote forty files is still one readable story: keep two, count the rest. */
function NodeGroup({
  group,
  view,
  place,
}: {
  group: OutputGroup;
  view: View;
  place: Place;
}) {
  const t = useTranslations("run.outputs");
  const opened = view.open.has(group.index);
  const folds = group.items.length > FOLD_OVER && !opened;
  const items = folds ? group.items.slice(0, FOLD_KEEP) : group.items;
  const fold = href(place, {
    reads: view.reads,
    open: withToggled(view.open, group.index),
  });
  return (
    <li>
      <ol className="m-0 list-none p-0">
        {keyedByOccurrence(
          items,
          (node) => `${node.kind}:${node.seq ?? "none"}:${node.name}`,
        ).map(({ item: node, key }) => (
          // Two changes to one path with no seq are two rows, so the key
          // carries how many times that identity appeared before it.
          <Node key={key} node={node} place={place} />
        ))}
        {group.items.length > FOLD_OVER ? (
          <li className="relative py-[5px]">
            <span aria-hidden="true" className={tick} />
            <SafeLink to={fold} className={linkQuiet}>
              {folds
                ? t("moreOfKind", {
                    count: group.items.length - FOLD_KEEP,
                    kind: t(`kind.${group.kind}`),
                  })
                : t("foldBack")}
            </SafeLink>
          </li>
        ) : null}
      </ol>
    </li>
  );
}

/**
 * The spine. A run that produced nothing still says so: an empty spine is a
 * fact about the run, not a state to hide.
 */
export function OutputsSpine({
  read,
  reads,
  spine,
  live = false,
  ...place
}: {
  read: Read<RunOutputs>;
  /** `?reads=hide` folds the read marks away. The tally keeps counting them. */
  reads: string | null;
  /** `?spine=`, the folded groups a person opened. */
  spine: string | null;
  /** A live run's spine fades out at the bottom: it is still being written. */
  live?: boolean;
} & Place) {
  const t = useTranslations("run.outputs");
  if (!read.ok) return <ReadFailure read={read} section={t("label")} />;
  const { nodes, tally, complete } = read.value;
  const view: View = { reads: reads !== "hide", open: parseOpen(spine) };

  const counts = [
    t("artifacts", { count: tally.artifacts }),
    tally.reads > 0 ? t("reads", { count: tally.reads }) : null,
    tally.gates > 0 ? t("gates", { count: tally.gates }) : null,
  ].filter((part) => part !== null);

  return (
    <section
      aria-label={t("label")}
      data-testid="run-outputs"
      className="rounded-xl border border-border bg-card px-[18px] pb-[13px] pt-[15px] text-card-foreground"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <h2 className={`${eyebrowQuiet} m-0`}>{t("title")}</h2>
        <span
          data-testid="run-outputs-tally"
          className="ml-auto font-mono text-[11px] text-dim"
        >
          {counts.join(" · ")}
        </span>
        {tally.reads > 0 ? (
          <SafeLink
            to={href(place, { reads: !view.reads, open: view.open })}
            className={linkQuiet}
          >
            {view.reads ? t("hideReads") : t("showReads")}
          </SafeLink>
        ) : null}
      </div>

      {nodes.length === 0 ? (
        <p className="border-l-2 border-dashed border-border py-2.5 pl-3 text-sm text-muted-foreground">
          {complete ? t("empty") : t("cut")}
        </p>
      ) : (
        <ol
          className={`relative m-0 list-none py-0 pl-[30px] before:absolute before:bottom-1.5 before:left-[11px] before:top-1.5 before:w-px before:content-[''] ${
            live
              ? "before:bg-gradient-to-b before:from-rule before:from-[78%] before:to-transparent"
              : "before:bg-rule"
          }`}
        >
          {groupNodes(nodes).map((group) =>
            group.kind === "read" ? (
              view.reads ? (
                <ReadMark
                  key={group.index}
                  group={group}
                  view={view}
                  place={place}
                />
              ) : null
            ) : (
              <NodeGroup
                key={group.index}
                group={group}
                view={view}
                place={place}
              />
            ),
          )}
        </ol>
      )}

      <p className="mt-[11px] flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-2.5 text-[11px] text-dim">
        <span>{t("footer")}</span>
        {complete ? null : <span>{t("cut")}</span>}
      </p>
    </section>
  );
}
