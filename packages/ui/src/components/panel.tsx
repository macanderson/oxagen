import * as React from "react";
import { cn } from "../lib/utils";

/**
 * coss ui Panel — a titled surface container.
 *
 * The workhorse layout block for settings, detail views and dashboards: an
 * optional header (eyebrow + title + actions slot), a padded body, and an
 * optional footer. Distinct from `CardPanel` (a body wrapper *inside* a Card) —
 * `Panel` is the whole surface.
 *
 *   <Panel
 *     eyebrow="Workspace"
 *     title="General settings"
 *     actions={<Button size="sm" variant="outline">Edit</Button>}
 *     footer={<Button>Save</Button>}
 *   >
 *     …body…
 *   </Panel>
 *
 * Optional treatments (default off, mirroring `Card`):
 * - `inset`        — removes body padding for flush content (tables).
 * - `glow`         — adds an `ox-glow-violet` class with no matching style; has no visual effect.
 * - `gradientRing` — adds a `gradient-ring` class with no matching style; has no visual effect.
 */
export interface PanelProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  /** Main heading rendered in the header. */
  title?: React.ReactNode;
  /** Small mono/uppercase label above the title. */
  eyebrow?: React.ReactNode;
  /** Right-aligned header slot (buttons, menus, badges). */
  actions?: React.ReactNode;
  /** Footer slot rendered below the body on a tinted bar. */
  footer?: React.ReactNode;
  /** Remove body padding for flush content like tables. */
  inset?: boolean;
  /** Adds an `ox-glow-violet` class; no style targets it, so this has no visual effect. */
  glow?: boolean;
  /** Adds a `gradient-ring` class; no style targets it, so this has no visual effect. */
  gradientRing?: boolean;
}

const Panel = React.forwardRef<HTMLElement, PanelProps>(
  (
    {
      className,
      title,
      eyebrow,
      actions,
      footer,
      inset = false,
      glow,
      gradientRing,
      children,
      ...props
    },
    ref,
  ) => {
    const hasHeader = Boolean(title || eyebrow || actions);
    return (
      <section
        ref={ref}
        className={cn(
          "flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm",
          glow && "ox-glow-violet",
          gradientRing && "gradient-ring",
          className,
        )}
        {...props}
      >
        {hasHeader && (
          <header className="flex items-center gap-3 border-b border-border px-[18px] py-[15px]">
            <div className="min-w-0 flex-1">
              {eyebrow && (
                <div className="mb-[3px] text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {eyebrow}
                </div>
              )}
              {title && (
                <h3 className="m-0 text-[15px] font-semibold leading-none tracking-tight">
                  {title}
                </h3>
              )}
            </div>
            {actions && (
              <div className="flex shrink-0 items-center gap-2">{actions}</div>
            )}
          </header>
        )}
        <div className={cn("min-h-0 flex-1", inset ? "p-0" : "p-[18px]")}>
          {children}
        </div>
        {footer && (
          <footer className="flex items-center gap-2 border-t border-border bg-muted/30 px-[18px] py-[13px]">
            {footer}
          </footer>
        )}
      </section>
    );
  },
);
Panel.displayName = "Panel";

export { Panel };
