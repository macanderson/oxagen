// The frame the empty, error, denied and not-recorded states share: an icon in
// a hairline tile, a heading, a paragraph and an actions row.
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useId } from "react";
import { cx } from "./cx";
import { GLYPH_TONE, type Tone } from "./tone";

export type StateFrameProps = {
  testId: string;
  icon: LucideIcon;
  tone?: Tone;
  title: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
};

export function StateFrame({
  testId,
  icon: Icon,
  tone = "neutral",
  title,
  body,
  actions,
  children,
}: StateFrameProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      data-testid={testId}
      className="mx-auto flex w-full max-w-xl flex-col items-center gap-3 px-4 py-12 text-center"
    >
      <span className="inline-flex size-10 items-center justify-center rounded-lg border border-border bg-card">
        <Icon
          aria-hidden
          focusable={false}
          className={cx("size-5", GLYPH_TONE[tone])}
        />
      </span>
      <h2 id={titleId} className="text-lg font-semibold text-foreground">
        {title}
      </h2>
      {body ? <p className="text-sm text-muted-foreground">{body}</p> : null}
      {children}
      {actions ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {actions}
        </div>
      ) : null}
    </section>
  );
}
