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

/**
 * `.btn.danger { color:var(--st-failed); border-color:<st-failed 40%> }` and
 * `.btn.danger:hover { background:<st-failed 12%> }`: an action that ends
 * something, such as Deregister. It carries the failed hue as ink, never a fill.
 */
export const buttonDanger = `${buttonBase} border border-error/40 bg-button-default-bg text-error-ink hover:bg-error/10 active:bg-error/15`;

/** `a { color:var(--accent-text) }` — gold as ink, underlined on hover. */
export const linkText =
  "font-medium text-link underline-offset-4 hover:text-link-hover hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm";

/**
 * The Account and Avatar dialogs' field label and the hint under a field
 * (`.field label`, `.field .hint`), and the small button beside a field.
 */
export const fieldLabel =
  "mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground";
export const fieldHint =
  "mt-1.5 text-xs leading-relaxed text-muted-foreground";
export const buttonSmall =
  "inline-flex min-h-8 flex-none items-center justify-center gap-1.5 rounded-md border border-button-default-border bg-button-default-bg px-2.5 text-xs font-medium text-button-default-fg hover:bg-button-default-hover-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-button-disabled-bg disabled:text-muted-foreground";

export const inputBase =
  // 16px below md as well as by phone.css, so the class list alone says an
  // input never makes iOS zoom the page on focus.
  "block w-full min-w-0 rounded-md border border-input-border bg-input-bg px-3 py-2 text-[13px] max-md:text-base text-input-fg placeholder:text-input-placeholder " +
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

/**
 * `.eyebrow.q { color:var(--muted) }`: the same caps line inside a panel,
 * where it names a section rather than the page's scope, so it is muted
 * rather than gold.
 */
export const eyebrowQuiet =
  "text-[12px] font-semibold uppercase tracking-[0.14em] text-muted-foreground";

export const mono = "font-mono text-[0.92em]";

/**
 * `.note { border-left:2px solid var(--gold); padding:2px 0 2px 12px;
 * font-size:12.5px; color:var(--muted) }`: the one sentence under a table or
 * a chart that says how to read it. The gold rule is identity, not state.
 */
export const note =
  "border-l-2 border-gold py-0.5 pl-3 text-[12.5px] text-muted-foreground";

/**
 * `.kv { display:grid; grid-template-columns:auto 1fr; gap:7px 16px;
 * font-size:12.5px }`, `.kv dt { color:var(--dim) }` and `.kv dd
 * { color:var(--body); overflow-wrap:anywhere }`: a record's fields, label
 * left in the dim ink and value right.
 */
export const kvList =
  "grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-[7px] text-[12.5px]";
export const kvTerm = "whitespace-nowrap text-dim";
export const kvValue = "m-0 min-w-0 text-foreground [overflow-wrap:anywhere]";

/**
 * `.b.b-q.lk` (the Run header's checkout strip): a quiet pill that is a link
 * or a copy button, so it carries the gold border and the wash on hover that
 * the badges around it do not.
 */
export const linkChip =
  "inline-flex min-w-0 max-w-full items-center gap-[5px] whitespace-nowrap rounded-md border border-border bg-hl px-[7px] py-0.5 text-[11px] font-semibold leading-normal tracking-[0.02em] text-muted-foreground transition-colors hover:border-gold hover:bg-hl hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * `.panel-h { padding:12px 16px; border-bottom:1px solid var(--border) }` and
 * `.panel-h h3 { font-size:13.5px }`, on the `--panel-head` band: light grey
 * on paper, a step lighter than the panel on ink (ADR-170). The footer keeps
 * the hairline and stays flat on the panel.
 */
export const panelHeader =
  "flex flex-wrap items-center justify-between gap-3 border-b border-border bg-panel-head px-4 py-3";
export const panelTitle = "text-[13.5px] font-semibold text-foreground";
export const panelFooter =
  "flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-xs text-muted-foreground";
/** `.panel-b { padding:14px 16px }` */
export const panelBody = "px-4 py-3.5";

/**
 * `.stat { background:var(--panel); border:1px solid var(--border);
 * border-radius:12px; padding:13px 15px }`, `.stat .k` (10.5px caps, dim),
 * `.stat .v` (23px, 700, tabular) and `.stat .s` (11.5px, muted). One tile of
 * a figure strip; every strip on every page draws these four. On a phone the
 * tile tightens to `#viewport.phone .stat { padding:11px 12px }` and its
 * figure to `.stat .v { font-size:17px }`, so two tiles fit a row.
 */
export const statTile =
  "flex min-w-0 flex-col rounded-xl border border-border bg-card px-[15px] py-[13px] text-card-foreground max-md:px-3 max-md:py-[11px]";
export const statTerm =
  "mb-[5px] text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim";
export const statValue =
  "text-[23px] font-bold leading-[1.15] tracking-[-0.02em] tabular-nums max-md:text-[17px]";
export const statNote = "mt-[3px] text-[11.5px] text-muted-foreground";
/**
 * `.grid.g4 { grid-template-columns:repeat(auto-fit,minmax(175px,1fr)); gap:14px }`,
 * and `#viewport.phone .g4 { grid-template-columns:1fr 1fr }`: a phone draws
 * the strip two by two rather than one tile to a row.
 */
/**
 * `.rstats { grid-template-columns:repeat(6,minmax(0,1fr)); gap:8px }` and
 * `.rstats .stat { padding:9px 11px }`, `.k { font-size:10px }`, `.v {
 * font-size:17px }`, `.s { font-size:10.5px }`: the Run page's six figures,
 * a tighter tile than the page strips, three across under 1380px and two on
 * a phone.
 */
export const runStatStrip =
  "grid grid-cols-2 gap-2 sm:grid-cols-3 min-[86.25rem]:grid-cols-6";
export const runStatTile =
  "flex min-w-0 flex-col rounded-xl border border-border bg-card px-[11px] py-[9px] text-card-foreground";
export const runStatTerm =
  "mb-[5px] text-[10px] font-semibold uppercase tracking-[0.1em] text-dim";
export const runStatValue =
  "text-[17px] font-bold leading-[1.15] tracking-[-0.02em] tabular-nums";
export const runStatNote = "mt-[3px] text-[10.5px] text-muted-foreground";
export const statStrip =
  "grid grid-cols-2 gap-3.5 md:[grid-template-columns:repeat(auto-fit,minmax(175px,1fr))]";
