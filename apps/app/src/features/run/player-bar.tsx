// The frame player bar (mockup `fpBar`, engine.css `.fp-bar`): step to the
// first, previous, next and last frame, play and pause at a chosen speed,
// scrub across the page, where the open frame sits, and what the run had
// spent by it.
//
// The steps are links, so each is a frame a reader can share. "By here" is the
// transcript's own running total at the open frame (`cumulativeCost`), set
// against the run's cost; a frame the transcript did not carry has no running
// total, and the bar says so rather than summing a page it cannot see past.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Cost } from "@/data/contracts/money";
import type { RunFrame } from "@/data/contracts/run";
import type { SafePath } from "@/shared/safe-path";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { formatCount, ratioWidth } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import {
  PlayButton,
  PlayerPlayback,
  PlayerScrub,
  PlaySpeed,
  type StepTargets,
} from "./frame-player";
import { MARK_HUE } from "./player-hues";
import type { Mark, OpenFrame } from "./player-model";
import { barButton, disabledStep } from "./player-styles";

/**
 * A step to another frame: a link when there is one that way, and a disabled
 * button when there is not, so the control never looks live and does nothing.
 */
export function StepLink({
  to,
  label,
  className,
  testId,
  children,
}: {
  to: SafePath | null;
  /** The accessible name, where the face is a glyph. */
  label?: string;
  className: string;
  testId: string;
  children: ReactNode;
}) {
  if (to === null)
    return (
      <button
        type="button"
        disabled
        aria-label={label}
        title={label}
        data-testid={testId}
        className={`${className} ${disabledStep}`}
      >
        {children}
      </button>
    );
  return (
    <SafeLink
      to={to}
      aria-label={label}
      title={label}
      data-testid={testId}
      className={className}
    >
      {children}
    </SafeLink>
  );
}

/** `.fp-cnt { font-family:var(--mono); font-size:11px; color:var(--dim); white-space:nowrap }`, `b { color:var(--fg); font-weight:600 }` */
const count =
  "whitespace-nowrap font-mono text-[11px] tabular-nums text-dim [&_b]:font-semibold [&_b]:text-foreground";

function Spent({ spent, total }: { spent: Cost | null; total: Cost | null }) {
  const t = useTranslations("run.player.bar");
  if (spent === null)
    return (
      <span data-testid="player-spent" className={count}>
        {t("spentNotRecorded")}
      </span>
    );
  const basis = spent.basis ?? t("basisNotRecorded");
  return (
    <span data-testid="player-spent" className={count}>
      {total === null
        ? t.rich("spentOnly", {
            spent: () => (
              <b>
                <Money value={spent} />
              </b>
            ),
            basis,
          })
        : t.rich("spent", {
            spent: () => (
              <b>
                <Money value={spent} />
              </b>
            ),
            total: () => <Money value={total} />,
            basis,
          })}
    </span>
  );
}

export function PlayerBar({
  frames,
  open,
  steps,
  hrefs,
  marks,
  spent,
  total,
  at,
}: {
  frames: readonly RunFrame[];
  open: OpenFrame;
  steps: StepTargets;
  /** Each frame on the page as the link that opens it, in order. */
  hrefs: readonly SafePath[];
  /** Each frame's scrub hue, null where it carries none. */
  marks: readonly (Mark | null)[];
  /** The run's running total at the open frame, from the transcript. */
  spent: Cost | null;
  /** The run's cost, with its basis. */
  total: Cost | null;
  /** When the open frame was recorded; null when neither read carries it. */
  at: string | null;
}) {
  const t = useTranslations("run.player.bar");
  const locale = useLocale();
  const format = useFormatter();
  const shown = frames.length;
  const time =
    at === null
      ? null
      : format.dateTime(new Date(at), {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          fractionalSecondDigits: 3,
          hourCycle: "h23",
        });
  const ticks = frames.flatMap((frame, j) => {
    const mark = marks[j] ?? null;
    return mark === null
      ? []
      : [
          {
            // `left:(n>1 ? j/(n-1)*100 : 0)+"%"`
            left: ratioWidth(shown > 1 ? j / (shown - 1) : 0),
            hue: MARK_HUE[mark],
            title: `${frame.seq} ${frame.type}`,
          },
        ];
  });
  return (
    <PlayerPlayback
      hrefs={hrefs}
      times={frames.map((frame) => Date.parse(frame.observedAt))}
      index={open.index}
      steps={steps}
      label={t("label")}
      // `.fp-bar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:10px 12px; border:1px solid var(--border); border-radius:10px; background:var(--panel) }`
      className="flex flex-wrap items-center gap-1.5 rounded-[10px] border border-border bg-card px-3 py-2.5"
    >
      <StepLink
        to={steps.first}
        label={t("first")}
        className={barButton}
        testId="player-first"
      >
        <span aria-hidden="true">⏮</span>
      </StepLink>
      <StepLink
        to={steps.prev}
        label={t("previous")}
        className={barButton}
        testId="player-previous"
      >
        <span aria-hidden="true">◀</span>
      </StepLink>
      <PlayButton />
      <StepLink
        to={steps.next}
        label={t("next")}
        className={barButton}
        testId="player-next"
      >
        <span aria-hidden="true">▶</span>
      </StepLink>
      <StepLink
        to={steps.last}
        label={t("last")}
        className={barButton}
        testId="player-last"
      >
        <span aria-hidden="true">⏭</span>
      </StepLink>
      <PlayerScrub
        key={open.seq}
        hrefs={hrefs}
        index={open.index}
        marks={ticks}
      />
      <span data-testid="player-position" className={count}>
        {open.index < 0
          ? t("positionOff", {
              seq: open.seq,
              shown: formatCount(shown, locale),
            })
          : t.rich(time === null ? "positionUntimed" : "position", {
              index: formatCount(open.index + 1, locale),
              shown: formatCount(shown, locale),
              seq: open.seq,
              time: time ?? "",
              b: (chunks) => <b>{chunks}</b>,
            })}
      </span>
      <Spent spent={spent} total={total} />
      <PlaySpeed />
      {/* `.fp-keys { display:inline-flex; gap:6px; font-size:11px; color:var(--dim); margin-left:auto }`, `kbd { font-family:var(--mono); font-size:10px; border:1px solid var(--border); border-radius:4px; padding:0 4px; color:var(--muted); background:var(--void) }` */}
      <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-dim max-md:hidden">
        {t.rich("keys", {
          k: (chunks) => (
            <kbd className="rounded border border-border bg-void px-1 font-mono text-[10px] text-muted-foreground">
              {chunks}
            </kbd>
          ),
        })}
      </span>
    </PlayerPlayback>
  );
}
