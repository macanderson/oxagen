// Two pieces the mandate page draws the design's way: the centred state panel
// (`.state-wrap` in the design's engine.css: an icon tile, a heading, one
// paragraph, the actions) and the one line that names an element nothing
// records yet.
//
// The state panel is local because no shared one exists on this base; the
// shell lane owns the shared version, and this one moves there when it lands.
import { CircleAlert, Lock, Table2 } from "lucide-react";
import type { ReactNode } from "react";

const ICONS = {
  empty: { Icon: Table2, tone: "text-muted-foreground border-border" },
  error: { Icon: CircleAlert, tone: "text-error-ink border-error/40" },
  denied: { Icon: Lock, tone: "text-warning border-warning/40" },
} as const;

export function StateWrap({
  kind,
  title,
  headingLevel = 2,
  testId,
  children,
  actions,
  below,
}: {
  kind: keyof typeof ICONS;
  title: string;
  headingLevel?: 2 | 3;
  testId: string;
  /** The one paragraph under the heading. */
  children: ReactNode;
  actions?: ReactNode;
  /** What sits under the actions: a trace line or a definition list. */
  below?: ReactNode;
}) {
  const { Icon, tone } = ICONS[kind];
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div
      data-testid={testId}
      data-state={kind}
      className="grid place-items-center px-5 py-[60px] text-center"
    >
      <span
        aria-hidden="true"
        className={`mb-3.5 grid size-11 place-items-center rounded-xl border bg-card ${tone}`}
      >
        <Icon className="size-5" />
      </span>
      <Heading className="mb-[7px] text-lg font-semibold text-foreground">
        {title}
      </Heading>
      <p className="mx-auto mb-4 max-w-[52ch] text-[13px] text-muted-foreground">
        {children}
      </p>
      {actions === undefined ? null : (
        <div className="flex flex-wrap justify-center gap-[9px]">{actions}</div>
      )}
      {below}
    </div>
  );
}

/**
 * An element the design draws and no store records yet, said in words rather
 * than filled with a zero or a guess. `gap` names the backend gap in the
 * implementation plan, so a reader of the DOM can find the issue that closes it.
 */
export function NotBacked({
  gap,
  children,
  block = false,
}: {
  gap: string;
  children: ReactNode;
  block?: boolean;
}) {
  const Tag = block ? "p" : "span";
  return (
    <Tag
      data-state="not-backed"
      data-gap={gap}
      className={`text-muted-foreground ${block ? "max-w-prose text-[12.5px]" : "text-xs"}`}
    >
      {children}
    </Tag>
  );
}
