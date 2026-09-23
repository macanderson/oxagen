// Class recipes for plain controls (buttons, links, inputs, panels, tiles,
// eyebrows) that are not their own component. Each recipe is one rule of the
// design of record, `mockups/src/engine.css` in the roadmap repository, named
// in the comment above it (ADR-132); the values are house tokens, so a reskin
// in the kit reaches every screen and the shape stays the mockup's.
//
// `design-record.test.ts` holds these recipes to the rules they cite. Change a
// recipe with the rule, never around it.

/**
 * `.btn { border:1px solid var(--border); background:var(--panel);
 * border-radius:9px; padding:7px 13px; font-size:13px; font-weight:500 }`.
 * A phone keeps the 44px touch target the mockup's sheet buttons have.
 */
const buttonBase =
  "inline-flex min-h-8 max-md:min-h-11 items-center justify-center gap-1.5 rounded-[9px] px-[13px] py-1.5 text-[13px] font-medium transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
  "disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed";

/**
 * `.btn.primary { background:var(--gold); border-color:var(--gold);
 * color:var(--on-gold); font-weight:600 }` — the one gold action a screen
 * carries (creation-spec §6: gold is identity, never state). The tokens
 * resolve to the gold in both themes (globals.css). Ink on gold is 9.5:1.
 */
export const buttonPrimary = `${buttonBase} border border-button-primary-border bg-button-primary-bg font-semibold text-button-primary-fg hover:bg-button-primary-hover-bg hover:border-button-primary-hover-bg active:bg-button-primary-active-bg`;

/**
 * `.btn` at rest: panel fill, hairline border, the wash on hover. The tokens
 * are the kit's default-button set, which globals.css points at the panel and
 * the wash so the recipe and the kit's own buttons agree.
 */
export const buttonSecondary = `${buttonBase} border border-button-default-border bg-button-default-bg text-button-default-fg hover:border-rule hover:bg-button-default-hover-bg active:bg-button-default-active-bg`;

/** `a { color:var(--accent-text) }` — gold as ink, underlined on hover. */
export const linkText =
  "font-medium text-link underline-offset-4 hover:text-link-hover hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm";

export const inputBase =
  "block w-full min-w-0 rounded-md border border-input-border bg-input-bg px-3 py-2 text-[13px] text-input-fg placeholder:text-input-placeholder " +
  "hover:border-input-border-hover focus-visible:border-input-border-focus focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-input-ring " +
  "disabled:bg-input-disabled-bg disabled:text-input-disabled-fg aria-invalid:border-input-invalid-border aria-invalid:outline-input-invalid-ring";

/** `.panel { background:var(--panel); border:1px solid var(--border); border-radius:12px; overflow:hidden }` */
export const panel =
  "app-panel min-w-0 overflow-hidden rounded-xl border border-border bg-card text-card-foreground";

/**
 * `.eyebrow { font-size:12px; letter-spacing:.14em; text-transform:uppercase;
 * color:var(--accent-text); font-weight:600 }` — the scope line over an h1,
 * in gold-as-ink.
 */
export const eyebrow =
  "text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-text";

export const mono = "font-mono text-[0.92em]";

/**
 * `.panel-h { padding:12px 16px; border-bottom:1px solid var(--border) }` and
 * `.panel-h h3 { font-size:13.5px }` — flat on the panel, no band. The same
 * hairline closes a footer.
 */
export const panelHeader =
  "flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3";
export const panelTitle = "text-[13.5px] font-semibold text-foreground";
export const panelFooter =
  "flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-xs text-muted-foreground";
/** `.panel-b { padding:14px 16px }` */
export const panelBody = "px-4 py-3.5";

/**
 * `.stat { background:var(--panel); border:1px solid var(--border);
 * border-radius:12px; padding:13px 15px }`, `.stat .k` (10.5px caps, dim),
 * `.stat .v` (23px, 700, tabular) and `.stat .s` (11.5px, muted). One tile of
 * a figure strip; every strip on every page draws these four.
 */
export const statTile =
  "flex min-w-0 flex-col rounded-xl border border-border bg-card px-[15px] py-[13px] text-card-foreground";
export const statTerm =
  "mb-[5px] text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim";
export const statValue =
  "text-[23px] font-bold leading-[1.15] tracking-[-0.02em] tabular-nums";
export const statNote = "mt-[3px] text-[11.5px] text-muted-foreground";
/**
 * `.grid.g4 { grid-template-columns:repeat(auto-fit,minmax(175px,1fr)); gap:14px }`,
 * and on a phone `#viewport.phone .g4 { grid-template-columns:1fr 1fr }`: two
 * 175px tiles and the gap need 364px, wider than a 390px phone's content, so
 * auto-fit alone would stack the strip one tile per row.
 */
export const statStrip =
  "grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(175px,1fr))] max-md:grid-cols-2";
