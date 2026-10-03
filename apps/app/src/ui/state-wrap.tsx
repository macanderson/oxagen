// The design's `.state-wrap` (engine.css, "state surfaces"; engine.js
// `emptyState`, `errorState` and `deniedState`): a glyph tile, a heading, one
// paragraph and the actions, centred on the page with no panel around them.
// Every state that stands in for a page body (not found, empty, error, access
// denied, a request still waiting) draws this shape. A lane passes its own
// copy, its tone and its controls; the frame, the glyphs and the type live
// here once, so no page draws its own.
//
// No hook and no "use client": a Server Component renders it on the server, a
// Client Component renders it in the browser, and global-error.tsx can use it
// with no provider above it.
import type { ReactNode } from "react";
import { kvList } from "./control-styles";

/** Which state the tile is in: the glyph's colour and its border. */
export type StateTone = "neutral" | "failed" | "denied";

/** The design's three glyphs: the empty panel, the circled mark, the lock. */
type StateGlyph = "empty" | "error" | "lock";

/**
 * `.state-wrap .ico { border:1px solid var(--border) }` for a neutral state,
 * and the tone the design sets inline on the others: `color:var(--st-failed);
 * border-color:<st-failed 40%>` and the same with `--st-denied`. Each tone
 * names exactly one border colour, so the tone wins without depending on the
 * order Tailwind emits two border utilities in.
 */
const TONE: Record<StateTone, string> = {
  neutral: "border-border text-foreground",
  failed: "border-error/40 text-error",
  denied: "border-warning/40 text-warning",
};

const DEFAULT_GLYPH: Record<StateTone, StateGlyph> = {
  neutral: "empty",
  failed: "error",
  denied: "lock",
};

function Glyph({ glyph }: { glyph: StateGlyph }) {
  switch (glyph) {
    case "error":
      return (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <path d="M12 8v5M12 17h.01" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
    case "lock":
      return (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <rect x="4" y="10" width="16" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      );
    case "empty":
      return (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18" />
        </svg>
      );
  }
}

/** `.state-wrap .ico`: 44px square, 12px corners, the panel fill, 14px above the heading. */
function StateIcon({ tone, glyph }: { tone: StateTone; glyph: StateGlyph }) {
  return (
    <div
      aria-hidden="true"
      data-state-icon={tone}
      className={`mb-3.5 grid size-11 place-items-center rounded-xl border bg-card ${TONE[tone]}`}
    >
      <Glyph glyph={glyph} />
    </div>
  );
}

/** `code { font-family:var(--mono); font-size:.9em; background:var(--hl); padding:.12em .38em; border-radius:4px }` */
export const stateCode =
  "rounded bg-hl px-[0.38em] py-[0.12em] font-mono text-[0.9em]";

/**
 * The trace line under an error's actions: `.mono.dim` at 11.5px, 16px below
 * them. It is a `.state-wrap p` too, so it keeps the paragraph's measure.
 */
export const stateTrace =
  "mx-auto mt-4 max-w-[52ch] font-mono text-[11.5px] text-dim";

/**
 * The denied state's facts: `.kv` with `margin-top:20px; text-align:left;
 * max-width:420px`. Its terms and values take `kvTerm` and `kvValue`.
 */
export const stateFacts = `${kvList} mt-5 max-w-[420px] text-left`;

type DataAttributes = { [key: `data-${string}`]: string | undefined };

/**
 * `.state-wrap { display:grid; place-items:center; padding:60px 20px;
 * text-align:center }`, its h2 (18px, 600, the display face, 7px below), its
 * paragraph (`max-width:52ch; margin:0 auto 16px`, 13px, muted) and `.acts`
 * (a centred row, 9px apart, wrapping).
 */
export function StateWrap({
  tone,
  glyph,
  title,
  heading = "h2",
  testId,
  titleId,
  children,
  actions,
  after,
  ...data
}: {
  tone: StateTone;
  /** The glyph when it is not the tone's own: a request still waiting draws the lock in the neutral tone. */
  glyph?: StateGlyph;
  title: ReactNode;
  /**
   * The heading's level. A state inside the shell is an h2, as the design
   * draws it; a page with no other heading (the root not-found page, the
   * global error) takes the h1 so the page still has one.
   */
  heading?: "h1" | "h2";
  testId?: string;
  /** The heading's id, which labels the section; `<testId>-title` when absent. */
  titleId?: string;
  /** The one paragraph. */
  children?: ReactNode;
  actions?: ReactNode;
  /** What follows the actions: a trace line, the denied state's facts, a note. */
  after?: ReactNode;
} & DataAttributes) {
  const Heading = heading;
  const id = titleId ?? (testId === undefined ? undefined : `${testId}-title`);
  return (
    <section
      {...data}
      data-testid={testId}
      aria-labelledby={id}
      className="grid place-items-center px-5 py-[60px] text-center"
    >
      <StateIcon tone={tone} glyph={glyph ?? DEFAULT_GLYPH[tone]} />
      <Heading
        id={id}
        className="mb-[7px] text-lg font-semibold tracking-[-0.015em] text-foreground"
      >
        {title}
      </Heading>
      {children === undefined ? null : (
        <p className="mx-auto mb-4 max-w-[52ch] text-[13px] text-muted-foreground">
          {children}
        </p>
      )}
      {actions === undefined || actions === null ? null : (
        <div className="flex flex-wrap justify-center gap-[9px]">{actions}</div>
      )}
      {after}
    </section>
  );
}
