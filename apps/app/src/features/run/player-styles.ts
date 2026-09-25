// The frame player bar's class recipes (engine.css `.fp-bar`, `.btn.sm`,
// `.seg`), shared by the steps the server draws and the play controls the
// client draws. They live apart from `frame-player.tsx` because a server
// component that imports from a "use client" module receives a reference,
// not the string.

/**
 * `.fp-bar .btn.sm { padding:3px 8px; font-family:var(--mono);
 * font-size:11.5px; justify-content:center }` over `.btn.sm`
 * (`border:1px solid; border-radius:7px; font-weight:500; gap:7px`), and
 * pressed `{ background:var(--hl); border-color:var(--rule);
 * color:var(--fg) }`. A phone keeps the 44px target. The width and the inks
 * are each button's own, so no two classes set one property.
 */
const shape =
  "inline-flex items-center justify-center gap-[7px] rounded-[7px] border px-2 py-[3px] font-mono text-[11.5px] font-medium transition-colors hover:border-rule aria-pressed:border-rule aria-pressed:bg-hl aria-pressed:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11";

/** `.btn { border-color:var(--border); background:var(--panel) }`, `:hover { background:var(--hl) }`. */
const raised =
  "border-button-default-border bg-button-default-bg text-button-default-fg hover:bg-button-default-hover-bg";

/** `.fp-bar .btn.sm { min-width:30px }` */
export const barButton = `${shape} ${raised} min-w-[30px] max-md:min-w-11`;

/** `.btn:disabled { opacity:.45; cursor:not-allowed }` */
export const disabledStep =
  "cursor-not-allowed opacity-45 hover:bg-button-default-bg";

/** `.fp-bar .play { min-width:82px }`, so the word can change without the bar moving. */
export const playButton = `${shape} ${raised} min-w-[82px] disabled:cursor-not-allowed disabled:opacity-45`;

/**
 * `.seg { display:inline-flex; gap:2px; padding:2px; border:1px solid
 * var(--border); border-radius:8px; background:var(--void) }`, set 4px off
 * the spend before it.
 */
export const speedSeg =
  "ml-1 inline-flex gap-0.5 rounded-lg border border-border bg-void p-0.5";

/** `.seg .btn { border-color:transparent; background:transparent }` */
export const speedButton = `${shape} min-w-[30px] border-transparent bg-transparent text-button-default-fg hover:bg-hl max-md:min-w-11`;
