// The frame player bar's layout classes (engine.css `.fp-bar`, `.seg`),
// shared by the steps the server draws and the play controls the client
// draws. They live apart from `frame-player.tsx` because a server component
// that imports from a "use client" module receives a reference, not the
// string.
//
// Every control in the bar is the kit's button at its `xs` size (#5283): the
// steps and play are `outline`, a step's link reads the same variant's
// classes, and the speeds are `ghost`. The variant draws the colour, border,
// radius and the disabled state, so these strings add only what the bar
// itself sets: the mono face at the bar's size, each control's width, and a
// phone's 44px target.

/** `.fp-bar .btn.sm { font-family:var(--mono); font-size:11.5px; min-width:30px }` */
export const barButton =
  "min-w-7.5 font-mono text-xs max-md:min-h-11 max-md:min-w-11";

/** `.fp-bar .play { min-width:82px }`, so the word can change without the bar moving. */
export const playButton = "min-w-20.5 font-mono text-xs max-md:min-h-11";

/**
 * `.seg { display:inline-flex; gap:2px; padding:2px; border:1px solid
 * var(--border); border-radius:8px; background:var(--void) }`, set 4px off
 * the spend before it.
 */
export const speedSeg =
  "ml-1 inline-flex gap-0.5 rounded-lg border border-border bg-void p-0.5";

/** `.seg .btn`, and pressed `{ background:var(--hl); border-color:var(--rule); color:var(--fg) }`. */
export const speedButton =
  "min-w-7.5 font-mono text-xs aria-pressed:border-rule aria-pressed:bg-hl aria-pressed:text-foreground max-md:min-h-11 max-md:min-w-11";
